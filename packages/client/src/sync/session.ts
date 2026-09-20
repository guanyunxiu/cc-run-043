import * as Y from 'yjs';
import type { BlockDoc } from '@coedit/block-core';
import {
  BlockRegistry,
  createDefaultRegistry,
  openFreshBlockDoc,
  openLoadedBlockDoc,
} from '@coedit/block-core';
import { EditorEngine } from '@coedit/renderer';
import type { UserInfo } from '@coedit/shared';
import { YjsDocStore } from '../persistence/doc-store.js';
import { TempStateStore } from '../persistence/queue.js';
import { SyncManager } from './sync-manager.js';

export interface SessionConfig {
  docId: string;
  token: string;
  user: UserInfo;
  wsUrl: string;
  httpUrl: string;
  preferredTransport?: 'ws' | 'poll';
  registry?: BlockRegistry;
}

/**
 * 单个文档的完整运行时，负责正确的启动时序：
 *
 *   new Y.Doc
 *     → YjsDocStore.loadInto（应用 IndexedDB 快照+离线增量，离线优先）
 *     → openLoadedBlockDoc（幂等补骨架；新文档补空段落）
 *     → YjsDocStore.bind（之后所有事务都本地持久化）
 *     → EditorEngine（渲染）
 *     → SyncManager.start（接入协同：先握手补齐远端，再重放本地队列）
 */
export class DocumentSession {
  readonly doc: BlockDoc;
  readonly engine: EditorEngine;
  readonly sync: SyncManager;
  readonly docId: string;
  private readonly ydoc: Y.Doc;
  private readonly store = new YjsDocStore();
  private readonly tempStore = new TempStateStore();
  private unbindPersist: (() => void) | null = null;

  private constructor(cfg: SessionConfig, ydoc: Y.Doc, localExisted: boolean) {
    this.ydoc = ydoc;
    this.docId = cfg.docId;
    // 本地有快照 → 离线优先直接打开；本地全新（首次/未缓存）→ 先建空文档，
    // 后续远端 SyncStep2 合并时由 integrateRemoteUpdate 收敛骨架。
    this.doc = localExisted
      ? openLoadedBlockDoc(ydoc, cfg.registry ?? createDefaultRegistry())
      : openFreshBlockDoc(ydoc, cfg.registry ?? createDefaultRegistry());
    this.engine = new EditorEngine({
      doc: this.doc,
      user: cfg.user,
      onLocalCursor: (cursor) => this.sync.setCursor(cursor),
    });
    this.sync = new SyncManager({
      doc: this.doc,
      docId: cfg.docId,
      token: cfg.token,
      user: cfg.user,
      wsUrl: cfg.wsUrl,
      httpUrl: cfg.httpUrl,
      preferredTransport: cfg.preferredTransport,
    });
  }

  static async create(cfg: SessionConfig): Promise<DocumentSession> {
    const ydoc = new Y.Doc();
    ydoc.guid = cfg.docId;
    const store = new YjsDocStore();
    const localExisted = await store.loadInto(cfg.docId, ydoc);

    const session = new DocumentSession(cfg, ydoc, localExisted);
    // 持久化绑定放在初始化之后：初始化产生的骨架 update 也会落盘
    session.unbindPersist = session.store.bind(cfg.docId, ydoc);
    // 初次压缩一次，确保刷新后快速启动
    void session.store.compact(cfg.docId, ydoc);

    return session;
  }

  mount(container: HTMLElement): void {
    this.engine.mount(container);
  }

  async startSync(): Promise<void> {
    await this.sync.start();
    const temp = await this.tempStore.load(this.docId);
    if (temp?.scrollTop !== undefined) {
      const scroller = this.engine.root.querySelector('.coedit-scroller') as HTMLElement | null;
      if (scroller) scroller.scrollTop = temp.scrollTop;
    }
  }

  /** 保存临时 UI 状态（滚动位置/活动块），不进入协同 */
  async saveTempState(extra: Record<string, unknown> = {}): Promise<void> {
    const scroller = this.engine.root.querySelector('.coedit-scroller') as HTMLElement | null;
    await this.tempStore.save({
      docId: this.docId,
      scrollTop: scroller?.scrollTop ?? 0,
      data: extra,
    });
  }

  async destroy(): Promise<void> {
    this.unbindPersist?.();
    this.sync.dispose();
    this.engine.dispose();
    this.ydoc.destroy();
  }
}
