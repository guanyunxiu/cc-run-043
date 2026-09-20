import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import {
  BlockDoc,
  BlockRegistry,
  CLIPBOARD_MIME,
  copyBlocks,
  parseClipboard,
  pasteBlocks,
  pastePlainText,
  toDataTransfer,
  type InlineAttributes,
} from '@blockeditor/core';
import { bindIndexedDB } from '../offline/persistence.js';
import { SyncQueue } from '../offline/sync-queue.js';
import { NetworkManager, type ConnectionPhase } from '../network/network.js';
import { BlockRenderer } from '../render/block-renderer.js';
import { RemoteCursorLayer } from '../render/remote-cursor-layer.js';
import type { TextBinding } from '../render/text-binding.js';
import {
  buildAwarenessState,
  colorForUser,
  type AwarenessState,
  type RemoteUser,
} from './awareness-state.js';

export interface SessionConfig {
  docId: string;
  user: { id: string; name: string };
  token: () => string | null;
  wsBaseUrl: string;
  httpBaseUrl: string;
  registry?: BlockRegistry;
}

export interface Caret {
  blockId: string;
  index: number;
}

/**
 * EditorSession —— 单文档编辑会话的装配根。
 *
 * 启动顺序保证"离线优先"：
 *  1. IndexedDB 先加载本地 Yjs 状态（无网也可立即编辑）；
 *  2. BlockDoc / 渲染引擎基于本地状态工作；
 *  3. 网络层后台握手，增量合并远端、幂等推送离线队列。
 */
export class EditorSession {
  readonly yDoc: Y.Doc;
  readonly blockDoc: BlockDoc;
  readonly awareness: Awareness;
  readonly user: RemoteUser;

  private persistence = null as unknown as ReturnType<typeof bindIndexedDB>;
  private queue: SyncQueue | null = null;
  private network: NetworkManager | null = null;
  private renderer: BlockRenderer | null = null;
  private cursorLayer: RemoteCursorLayer | null = null;
  private caret: Caret | null = null;
  private activeMarks: InlineAttributes = {};
  private statusListeners = new Set<(phase: ConnectionPhase, detail?: string) => void>();
  private remoteListeners = new Set<(states: Map<number, AwarenessState>) => void>();

  constructor(public readonly config: SessionConfig) {
    this.yDoc = new Y.Doc();
    this.blockDoc = new BlockDoc(this.yDoc, {
      registry: config.registry ?? BlockRegistry.createDefault(),
      userId: config.user.id,
    });
    this.awareness = new Awareness(this.yDoc);
    this.user = {
      id: config.user.id,
      name: config.user.name,
      color: colorForUser(config.user.id),
    };
    this.awareness.setLocalStateField('user', this.user);
    this.awareness.setLocalStateField('cursor', null);
  }

  /** 1) 挂载到容器 DOM；2) 加载本地状态；3) 发起协同连接。 */
  async mount(container: HTMLElement): Promise<void> {
    // 本地持久化先于渲染：synced 后 DOM 直接呈现离线缓存内容。
    this.persistence = bindIndexedDB(this.yDoc, this.config.docId);
    this.queue = new SyncQueue(this.persistence.queue);
    await this.persistence.whenSynced;

    this.seedIfEmpty();

    this.renderer = new BlockRenderer(this.blockDoc, container, {
      onBindingCreated: (binding) => this.wireBinding(binding),
    });
    this.cursorLayer = new RemoteCursorLayer(this.awareness, this.renderer, container);
    this.awareness.on('change', () => this.emitRemotes());

    this.network = new NetworkManager({
      blockDoc: this.blockDoc,
      yDoc: this.yDoc,
      awareness: this.awareness,
      queue: this.queue!,
      docId: this.config.docId,
      token: this.config.token,
      wsUrl: `${this.config.wsBaseUrl}/collab/ws`,
      httpUrl: this.config.httpBaseUrl,
    });
    this.network.onPhase = (phase, detail) => {
      for (const listener of this.statusListeners) listener(phase, detail);
    };
    this.network.start();

    // 周期广播光标（页面失焦时也让对端看到最后位置）。
    window.addEventListener('beforeunload', this.handleBeforeUnload);
  }

  destroy(): void {
    window.removeEventListener('beforeunload', this.handleBeforeUnload);
    this.network?.stop();
    this.cursorLayer?.destroy();
    this.renderer?.destroy();
    this.awareness.destroy();
    this.persistence?.destroy();
    this.yDoc.destroy();
  }

  /** 空文档插入一个初始段落，保证有可编辑块。 */
  private seedIfEmpty(): void {
    if (this.blockDoc.length === 0) {
      this.blockDoc.createBlock({ type: 'paragraph' });
    }
  }

  // -------------------------------------------------------------------------
  // 块渲染接线：TextBinding 的编辑意图 -> BlockDoc Yjs 事务
  // -------------------------------------------------------------------------

  private wireBinding(binding: TextBinding): void {
    binding.onEdit = (action) => {
      const id = binding.node.id;
      switch (action.type) {
        case 'insert':
          this.blockDoc.insertText(id, action.index, action.text, { ...this.activeMarks });
          this.setCaret({ blockId: id, index: action.index + action.text.length });
          break;
        case 'delete':
          this.blockDoc.deleteText(id, action.index, action.length);
          this.setCaret({ blockId: id, index: action.index });
          break;
        case 'split': {
          const { newId } = this.blockDoc.splitBlock(id, action.index);
          this.setCaret({ blockId: newId, index: 0 });
          break;
        }
        case 'merge': {
          const result = this.blockDoc.mergeWithPrevious(id);
          if (result) this.setCaret({ blockId: result.targetId, index: result.caretIndex });
          break;
        }
      }
    };
    binding.onSelectionChange = (index) => {
      if (index === null) return;
      this.setCaret({ blockId: binding.node.id, index });
    };
  }

  private setCaret(caret: Caret): void {
    this.caret = caret;
    // caret 变化经 awareness 以二进制增量广播给房间内其他用户。
    this.awareness.setLocalStateField('cursor', { blockId: caret.blockId, index: caret.index });
    this.renderer?.focusBlock(caret.blockId, caret.index);
  }

  get currentCaret(): Caret | null {
    return this.caret;
  }

  // -------------------------------------------------------------------------
  // 工具栏操作
  // -------------------------------------------------------------------------

  setActiveMarks(marks: InlineAttributes): void {
    this.activeMarks = marks;
    if (this.caret) {
      // 对当前选区即时套用（由 TextBinding 找到具体 binding 执行）。
      this.renderer?.getBinding(this.caret.blockId)?.formatSelection(marks);
    }
  }

  setBlockType(type: string, attrs?: Record<string, unknown>): void {
    if (this.caret) {
      this.blockDoc.setBlockType(this.caret.blockId, type, attrs);
    }
  }

  setHeading(level: number): void {
    this.setBlockType('heading', { level });
  }

  insertBlock(type: string): void {
    const index = this.caret ? this.blockDoc.indexOf(this.caret.blockId) + 1 : this.blockDoc.length;
    const id = this.blockDoc.createBlock({ type, index });
    this.setCaret({ blockId: id, index: 0 });
  }

  moveBlock(id: string, toIndex: number): void {
    this.blockDoc.moveBlock(id, toIndex);
  }

  deleteBlock(id: string): void {
    this.blockDoc.deleteBlock(id);
  }

  undo(): void {
    this.blockDoc.undo();
  }

  redo(): void {
    this.blockDoc.redo();
  }

  // -------------------------------------------------------------------------
  // 全局块复制 / 粘贴（与系统剪贴板互通，纯文本兜底）
  // -------------------------------------------------------------------------

  copySelected(ids: string[]): void {
    const data = copyBlocks(this.blockDoc, ids);
    const payload = toDataTransfer(data);
    void navigator.clipboard?.writeText(payload.text).catch(() => undefined);
    // 富格式暂存到 window 级缓冲，供同域 paste 读取（浏览器 clipboard 写自定义 MIME 受限）。
    blockClipboardCache.set(this.config.docId, payload.json);
  }

  copyCurrentBlock(): void {
    if (this.caret) this.copySelected([this.caret.blockId]);
  }

  /**
   * 粘贴入口。优先读取块格式（DataTransfer / 同域缓存），
   * 否则将外部纯文本按行拆为段落块。返回是否已处理。
   */
  paste(event: ClipboardEvent): boolean {
    if (!this.caret) return false;
    const dataTransfer = event.clipboardData;
    const blockJson =
      dataTransfer?.getData(CLIPBOARD_MIME) ||
      blockClipboardCache.get(this.config.docId) ||
      null;
    const atIndex = this.blockDoc.indexOf(this.caret.blockId) + 1;

    if (blockJson) {
      const parsed = parseClipboard(blockJson);
      if (parsed) {
        event.preventDefault();
        const result = pasteBlocks(this.blockDoc, parsed, atIndex);
        if (result.caret) this.setCaret(result.caret);
        return true;
      }
    }
    const text = dataTransfer?.getData('text/plain');
    if (text) {
      event.preventDefault();
      const result = pastePlainText(this.blockDoc, text, atIndex);
      if (result.caret) this.setCaret(result.caret);
      return true;
    }
    return false;
  }

  copy(event: ClipboardEvent): boolean {
    if (!this.caret) return false;
    const data = copyBlocks(this.blockDoc, [this.caret.blockId]);
    const payload = toDataTransfer(data);
    event.clipboardData?.setData(CLIPBOARD_MIME, payload.json);
    event.clipboardData?.setData('text/plain', payload.text);
    blockClipboardCache.set(this.config.docId, payload.json);
    event.preventDefault();
    return true;
  }

  // -------------------------------------------------------------------------
  // 状态订阅
  // -------------------------------------------------------------------------

  onStatus(listener: (phase: ConnectionPhase, detail?: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onRemoteUsers(listener: (states: Map<number, AwarenessState>) => void): () => void {
    this.remoteListeners.add(listener);
    return () => this.remoteListeners.delete(listener);
  }

  private emitRemotes(): void {
    const map = new Map<number, AwarenessState>();
    this.awareness.getStates().forEach((raw, clientId) => {
      if (clientId === this.awareness.clientID) return;
      if (raw.user && raw.cursor) map.set(clientId, raw as AwarenessState);
    });
    for (const listener of this.remoteListeners) listener(map);
  }

  private readonly handleBeforeUnload = (): void => {
    // 通知房间光标离线；y-indexeddb 自身保证 Yjs 状态已落盘。
    this.awareness.setLocalStateField('cursor', null);
  };
}

/** 同标签页块剪贴板兜底缓存（key: docId）。 */
const blockClipboardCache = new Map<string, string>();
