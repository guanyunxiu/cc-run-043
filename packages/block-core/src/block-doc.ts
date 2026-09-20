import * as Y from 'yjs';
import type {
  BlockMeta,
  BlockType,
  ClipboardBlock,
  ClipboardPayload,
  InlineAttributes,
} from '@coedit/shared';
import { createBlockId } from '@coedit/shared';
import { BlockRegistry, createDefaultRegistry } from './registry.js';
import {
  deserializeBlocks,
  serializeBlocks,
  CLIPBOARD_MIME,
} from './clipboard.js';
import { HistoryManager } from './history.js';

/**
 * Yjs 存储布局（挂在单一 Y.Doc 下，所有修改经 Yjs 事务驱动 → 天然 CRDT）：
 *
 * root: Y.Map
 *   title:      Y.Text                         文档标题（行内富文本）
 *   order:      Y.Array<string>                顶层块 id 有序列表（移动/排序的唯一真源）
 *   blocks:     Y.Map<id, block>               块表（结构隔离：块之间互不嵌套私有结构）
 *     block:    Y.Map
 *       id/type/createdBy/createdAt: 基础元数据
 *       props:     Y.Map                        自定义属性（可放任意 JSON）
 *       text:      Y.Text                       行内文本（仅 inlineText 块存在）
 *   containers: Y.Map<id, Y.Array<string>>      容器块（表格等，迭代 2）子块顺序
 */
const K_TITLE = 'title';
const K_ORDER = 'order';
const K_BLOCKS = 'blocks';
const K_PROPS = 'props';
const K_TEXT = 'text';
const K_CREATED_BY = 'createdBy';
const K_CREATED_AT = 'createdAt';
const K_TYPE = 'type';
const K_CONTAINERS = 'containers';

/** 本地编辑事务来源（UndoManager 仅追踪该 origin，远端应用不进撤销栈） */
export const LOCAL_ORIGIN = Symbol('coedit.local-edit');
/** 远端更新应用来源 */
export const REMOTE_ORIGIN = Symbol('coedit.remote-update');
/**
 * 文档骨架初始化来源。
 * 关键点：
 *  1) 仍会产生 Yjs update 并同步给对端（origin 不影响同步，只影响本地撤销追踪）；
 *  2) 不进 UndoManager —— 骨架合并不是用户编辑，不允许被撤销掉。
 */
export const SETUP_ORIGIN = Symbol('coedit.setup');

type BlockYMap = Y.Map<any>;

export interface CreateBlockOptions {
  id?: string;
  type?: BlockType;
  text?: string;
  props?: Record<string, unknown>;
}

export interface BlockEvent {
  type: 'add' | 'delete' | 'update' | 'move';
  blockId?: string;
}

export class BlockDoc {
  readonly doc: Y.Doc;
  readonly registry: BlockRegistry;
  readonly history: HistoryManager;

  /**
   * 仅绑定顶层 root。嵌套结构（blocks/order/...）一律延迟解析：
   * 不在构造时立即创建，避免"对端尚不存在时双方各自创建同名嵌套类型"
   * 导致的 Yjs CRDT 键冲突（会产生对彼此不可见的孤立类型）。
   */
  private readonly root: Y.Map<any>;

  constructor(doc?: Y.Doc, registry?: BlockRegistry) {
    this.doc = doc ?? new Y.Doc();
    this.registry = registry ?? createDefaultRegistry();
    // 'root' 是文档级唯一顶层入口；后续所有结构都挂在它下面。
    this.root = this.doc.getMap('root');
    this.history = new HistoryManager(this.root);
  }

  // -------------------------------------------------------------------------
  // 结构解析（始终从 root 现读，不缓存引用）
  // -------------------------------------------------------------------------

  private get blocks(): Y.Map<BlockYMap> {
    return this.root.get(K_BLOCKS) as Y.Map<BlockYMap>;
  }

  private get order(): Y.Array<string> {
    return this.root.get(K_ORDER) as Y.Array<string>;
  }

  private get containers(): Y.Map<Y.Array<string>> {
    return this.root.get(K_CONTAINERS) as Y.Map<Y.Array<string>>;
  }

  /**
   * 幂等文档骨架初始化：只在缺失时创建固定键。
   *
   * 协同时序约束（重要）：
   *  - 新建文档：在接入网络前由一方调用一次；
   *  - 加入已有文档：先应用本地快照或首个 SyncStep2，再调用 ——
   *    此时固定键已存在，本方法成为纯 no-op，绝不重复创建嵌套类型；
   *  - 多人同时从零建文档：各方写入的"同名新类型"由 Yjs Map 按
   *    (clientID, clock) 确定性裁决，收敛到唯一胜者；结构键集合固定，
   *    至多丢弃空骨架，不丢失任何内容。
   */
  ensureInitialized(): void {
    if (this.order && this.blocks) return;
    this.doc.transact(() => {
      if (!this.root.has(K_BLOCKS)) this.root.set(K_BLOCKS, new Y.Map());
      if (!this.root.has(K_ORDER)) this.root.set(K_ORDER, new Y.Array<string>());
      if (!this.root.has(K_CONTAINERS)) this.root.set(K_CONTAINERS, new Y.Map());
      if (!this.root.has(K_TITLE)) this.root.set(K_TITLE, new Y.Text());
    }, SETUP_ORIGIN);
  }

  /** 结构是否已就绪（持久化层据此判断是否需要拉取/初始化） */
  get isInitialized(): boolean {
    return !!(this.order && this.blocks);
  }

  // -------------------------------------------------------------------------
  // 基础查询
  // -------------------------------------------------------------------------

  get id(): string {
    return this.doc.guid;
  }

  get clientId(): number {
    return this.doc.clientID;
  }

  get title(): Y.Text {
    return this.root.get(K_TITLE) as Y.Text;
  }

  private requireReady(): void {
    if (!this.isInitialized) {
      throw new Error('BlockDoc not initialized: call ensureInitialized() after loading / before editing');
    }
  }

  getBlockIds(): string[] {
    if (!this.isInitialized) return [];
    return this.order.toArray();
  }

  hasBlock(id: string): boolean {
    return this.isInitialized ? this.blocks.has(id) : false;
  }

  private blockY(id: string): BlockYMap {
    const b = this.blocks.get(id);
    if (!b) throw new Error(`block not found: ${id}`);
    return b;
  }

  getMeta(id: string): BlockMeta {
    const b = this.blockY(id);
    return {
      id: b.get('id') as string,
      type: b.get(K_TYPE) as BlockType,
      created: {
        at: b.get(K_CREATED_AT) as number,
        by: b.get(K_CREATED_BY) as string,
      },
      props: (b.get(K_PROPS) as Y.Map<unknown>).toJSON(),
    };
  }

  getType(id: string): BlockType {
    return this.blockY(id).get(K_TYPE) as BlockType;
  }

  getText(id: string): Y.Text {
    const text = this.blockY(id).get(K_TEXT);
    if (!(text instanceof Y.Text)) {
      throw new Error(`block ${id} has no inline text (type=${this.getType(id)})`);
    }
    return text;
  }

  getProps(id: string): Y.Map<unknown> {
    return this.blockY(id).get(K_PROPS) as Y.Map<unknown>;
  }

  /** @internal 渲染引擎使用：拿到底层块 Y.Map 以做深度观察 / 文本绑定 */
  _getBlockYMap(id: string): Y.Map<any> {
    return this.blockY(id);
  }

  /** 序列化整个文档（调试/全量快照用；协同走二进制增量，不走此路径） */
  toJSON(): { title: string; blocks: BlockMeta[] } {
    return {
      title: this.title.toJSON(),
      blocks: this.getBlockIds().map((id) => this.getMeta(id)),
    };
  }

  // -------------------------------------------------------------------------
  // 新增 / 删除 / 移动 —— 全部 Yjs 事务
  // -------------------------------------------------------------------------

  /**
   * 新增块。index 缺省时追加到末尾。
   * 同一事务内完成 blocks 表写入 + order 插入，保证结构一致。
   */
  createBlock(
    opts: CreateBlockOptions = {},
    index?: number,
    origin: unknown = LOCAL_ORIGIN,
  ): string {
    this.requireReady();
    const type = (opts.type ?? 'paragraph') as BlockType;
    const def = this.registry.require(type as string);
    if (def.reserved) {
      throw new Error(
        `block type "${type}" is reserved for a future version and not creatable yet`,
      );
    }
    const id = opts.id ?? createBlockId();

    this.doc.transact(() => {
      if (this.blocks.has(id)) throw new Error(`duplicate block id: ${id}`);
      const b = new Y.Map<unknown>();
      b.set('id', id);
      b.set(K_TYPE, type);
      b.set(K_CREATED_AT, Date.now());
      b.set(K_CREATED_BY, String(this.doc.clientID));

      const props = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(def.defaultProps ?? {})) props.set(k, v);
      for (const [k, v] of Object.entries(opts.props ?? {})) props.set(k, v);
      b.set(K_PROPS, props);

      if (def.inlineText) {
        const text = new Y.Text(opts.text ?? '');
        b.set(K_TEXT, text);
      }
      this.blocks.set(id, b);

      const at = index === undefined ? this.order.length : Math.max(0, Math.min(index, this.order.length));
      this.order.insert(at, [id]);
    }, origin);

    return id;
  }

  /** 删除块：同时移除 blocks 表与 order（容器块连带其顺序索引） */
  deleteBlock(id: string): void {
    this.doc.transact(() => {
      if (!this.blocks.has(id)) return;
      this.blocks.delete(id);
      const idx = this.order.toArray().indexOf(id);
      if (idx >= 0) this.order.delete(idx, 1);
      if (this.containers.has(id)) this.containers.delete(id);
    }, LOCAL_ORIGIN);
  }

  /**
   * 移动块：从当前位置移除后插入到 targetIndex（基于删除前的逻辑顺序）。
   * 底层是 Y.Array 两次操作；CRDT 在多人并发拖拽时按 Yjs 冲突策略无冲突收敛。
   */
  moveBlock(id: string, targetIndex: number): void {
    this.doc.transact(() => {
      const ids = this.order.toArray();
      const from = ids.indexOf(id);
      if (from < 0) throw new Error(`block not in order: ${id}`);
      if (from === targetIndex) return;
      this.order.delete(from, 1);
      const clamped = Math.max(0, Math.min(targetIndex, this.order.length));
      this.order.insert(clamped, [id]);
    }, LOCAL_ORIGIN);
  }

  /** 修改块类型（保留文本；按目标定义重建 props 默认值后浅合并旧 props） */
  setBlockType(id: string, type: BlockType, props?: Record<string, unknown>): void {
    const def = this.registry.require(type as string);
    this.doc.transact(() => {
      const b = this.blockY(id);
      const oldProps = (b.get(K_PROPS) as Y.Map<unknown>).toJSON();
      b.set(K_TYPE, type);
      const nextProps = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(def.defaultProps ?? {})) nextProps.set(k, v);
      for (const [k, v] of Object.entries(oldProps)) nextProps.set(k, v);
      for (const [k, v] of Object.entries(props ?? {})) nextProps.set(k, v);
      b.set(K_PROPS, nextProps);
      if (def.inlineText && !(b.get(K_TEXT) instanceof Y.Text)) {
        b.set(K_TEXT, new Y.Text());
      } else if (!def.inlineText && b.has(K_TEXT)) {
        b.delete(K_TEXT);
      }
    }, LOCAL_ORIGIN);
  }

  setProp(id: string, key: string, value: unknown): void {
    this.doc.transact(() => {
      this.getProps(id).set(key, value);
    }, LOCAL_ORIGIN);
  }

  deleteProp(id: string, key: string): void {
    this.doc.transact(() => {
      this.getProps(id).delete(key);
    }, LOCAL_ORIGIN);
  }

  // -------------------------------------------------------------------------
  // 行内文本编辑（块结构隔离：每个块独占自己的 Y.Text）
  // -------------------------------------------------------------------------

  insertText(id: string, index: number, text: string, attrs?: InlineAttributes): void {
    this.doc.transact(() => {
      this.getText(id).insert(index, text, attrs ? sanitizeAttrs(attrs) : undefined);
    }, LOCAL_ORIGIN);
  }

  deleteText(id: string, index: number, length: number): void {
    if (length <= 0) return;
    this.doc.transact(() => {
      this.getText(id).delete(index, length);
    }, LOCAL_ORIGIN);
  }

  formatText(id: string, index: number, length: number, attrs: InlineAttributes): void {
    this.doc.transact(() => {
      this.getText(id).format(index, length, sanitizeAttrs(attrs));
    }, LOCAL_ORIGIN);
  }

  toggleMark(id: string, index: number, length: number, mark: keyof InlineAttributes): void {
    const text = this.getText(id);
    const attrs = text.toDelta()[0]?.attributes;
    const active = !!attrs?.[mark];
    this.formatText(id, index, length, { [mark]: active ? null : true } as InlineAttributes);
  }

  // -------------------------------------------------------------------------
  // 高级结构编辑：拆分 / 合并（回车键、退格键）
  // -------------------------------------------------------------------------

  /**
   * 在 offset 处拆分当前块：尾部文本移入新块。
   * 代码块（multiline）不允许拆分，应直接插入 '\n'。
   * @returns 新块 id
   */
  splitBlockAt(id: string, offset: number, newType?: BlockType): string {
    const def = this.registry.require(this.getType(id) as string);
    if (def.multiline) throw new Error('multiline block cannot be split');
    const text = this.getText(id);
    const tailDelta = text.toDelta().flatMap((op: any) =>
      typeof op.insert === 'string' && op.insert.length ? [{
        insert: op.insert as string,
        attributes: op.attributes,
      }] : [],
    );

    let newId = '';
    this.doc.transact(() => {
      const index = this.order.toArray().indexOf(id);
      newId = createBlockId();
      const type = (newType ?? this.getType(id)) as BlockType;
      const newDef = this.registry.require(type as string);

      const b = new Y.Map<unknown>();
      b.set('id', newId);
      b.set(K_TYPE, type);
      b.set(K_CREATED_AT, Date.now());
      b.set(K_CREATED_BY, String(this.doc.clientID));
      const props = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(newDef.defaultProps ?? {})) props.set(k, v);
      // 复制结构化属性（如 heading.level），但跳过语义不该继承的属性
      const oldProps = this.getProps(id).toJSON();
      for (const [k, v] of Object.entries(oldProps)) {
        if (k !== 'language') props.set(k, v);
      }
      b.set(K_PROPS, props);

      const newText = new Y.Text();
      // 将 tail 落在 offset 之后的 delta 应用到新块，并从旧块截断
      let cursor = 0;
      for (const op of tailDelta) {
        const len = op.insert.length;
        const start = cursor;
        const end = cursor + len;
        cursor = end;
        if (end <= offset) continue; // 全在头
        const cutStart = Math.max(start, offset);
        const piece = op.insert.slice(cutStart - start, end - start);
        newText.insert(newText.length, piece, op.attributes);
      }
      b.set(K_TEXT, newText);
      this.blocks.set(newId, b);
      this.order.insert(index + 1, [newId]);

      const len = text.length;
      if (offset < len) text.delete(offset, len - offset);
    }, LOCAL_ORIGIN);
    return newId;
  }

  /**
   * 将当前块合并进上一块：当前块文本追加到上一块尾部，然后删除当前块。
   * @returns 合并后的块 id（即上一块）；若当前块已是首块则返回 null
   */
  mergeWithPrevious(id: string): { targetId: string; offset: number } | null {
    const ids = this.order.toArray();
    const index = ids.indexOf(id);
    if (index <= 0) return null;
    const targetId = ids[index - 1];
    let offset = 0;

    this.doc.transact(() => {
      const target = this.blockY(targetId);
      const source = this.blockY(id);
      const targetDef = this.registry.require(target.get(K_TYPE) as string);
      const sourceDef = this.registry.require(source.get(K_TYPE) as string);
      if (!targetDef.inlineText || !sourceDef.inlineText) {
        // 结构化块之间的合并在迭代 2 定义；这里仅删除当前块
        this.blocks.delete(id);
        this.order.delete(index, 1);
        return;
      }
      const targetText = target.get(K_TEXT) as Y.Text;
      const sourceText = source.get(K_TEXT) as Y.Text;
      offset = targetText.length;
      const needNl = targetDef.multiline && offset > 0;
      if (needNl) targetText.insert(offset, '\n');
      const delta = sourceText.toDelta();
      let pos = offset + (needNl ? 1 : 0);
      for (const op of delta) {
        if (typeof op.insert === 'string') {
          targetText.insert(pos, op.insert, op.attributes);
          pos += op.insert.length;
        }
      }
      this.blocks.delete(id);
      this.order.delete(index, 1);
    }, LOCAL_ORIGIN);

    return { targetId, offset };
  }

  // -------------------------------------------------------------------------
  // 全局块复制 / 粘贴（跨文档；id 在粘贴时重新生成，避免污染 CRDT 身份）
  // -------------------------------------------------------------------------

  serializeBlocks(ids: string[], sourceDocId = this.id): ClipboardPayload {
    return serializeBlocks(this, ids, sourceDocId);
  }

  toClipboardDataTransfer(ids: string[]): DataTransfer {
    const dt = new DataTransfer();
    const payload = this.serializeBlocks(ids);
    dt.setData(CLIPBOARD_MIME, JSON.stringify(payload));
    // 同时给一份纯文本，允许粘贴到系统其它编辑器
    dt.setData(
      'text/plain',
      payload.blocks
        .map((b) => b.delta.map((d) => d.insert).join(''))
        .join('\n'),
    );
    return dt;
  }

  /**
   * 粘贴：从剪贴板负载在 atIndex 处插入块，返回新块 id 列表。
   * 与"当前块为空"的替换场景由调用方决定（先删后粘）。
   */
  pastePayload(payload: ClipboardPayload, atIndex?: number): string[] {
    return deserializeBlocks(this, payload, atIndex);
  }

  pasteFromDataTransfer(data: DataTransfer, atIndex?: number): string[] | null {
    const raw = data.getData(CLIPBOARD_MIME);
    if (!raw) return null;
    try {
      return this.pastePayload(JSON.parse(raw) as ClipboardPayload, atIndex);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 观察 / 事务
  // -------------------------------------------------------------------------

  /**
   * 监听块结构变化（新增/删除/排序）。对延迟初始化健壮：
   * 骨架尚未创建时先观察 root，待 blocks/order 出现后自动绑定。
   */
  observeBlocks(cb: (e: BlockEvent) => void): () => void {
    const handler = (e: Y.YEvent<any>) => cb(structuralEvent(e));
    let disposed = false;
    let unbindInner: (() => void) | null = null;

    const bindInner = () => {
      if (disposed || unbindInner || !this.isInitialized) return;
      this.blocks.observe(handler);
      this.order.observe(handler);
      unbindInner = () => {
        this.blocks.unobserve(handler);
        this.order.unobserve(handler);
      };
      cb({ type: 'add' }); // 骨架就绪，触发一次重算
    };

    const rootHandler = () => bindInner();
    this.root.observe(rootHandler);
    bindInner();

    return () => {
      disposed = true;
      this.root.unobserve(rootHandler);
      unbindInner?.();
    };
  }

  /** 深度观察（props / 行内文本的全部深层修改） */
  observeDeep(
    cb: (events: Y.YEvent<any>[], origin: unknown) => void,
  ): () => void {
    const handler = (events: Y.YEvent<any>[], transaction: Y.Transaction) => {
      cb(events, transaction.origin);
    };
    this.root.observeDeep(handler);
    return () => this.root.unobserveDeep(handler);
  }

  /**
   * 订阅原始二进制增量（供 SyncManager / IndexedDB 持久化层使用）。
   * 本地编辑与远端应用都会产出 update，调用方按 origin 区分。
   */
  onUpdate(cb: (update: Uint8Array, origin: unknown) => void): () => void {
    const handler = (update: Uint8Array, origin: unknown) => cb(update, origin);
    this.doc.on('update', handler);
    return () => this.doc.off('update', handler);
  }

  /** 供持久化 / 同步层在统一事务中批量操作 */
  transact(fn: () => void, origin: unknown = LOCAL_ORIGIN): void {
    this.doc.transact(fn, origin);
  }

  /** 应用远端二进制增量（离线恢复 / WebSocket / 长轮询共用入口） */
  applyRemoteUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
  }

  /**
   * 协同入口：应用远端增量，随后幂等补齐骨架。
   *
   * 与"先 createEmptyBlockDoc 再联网"的关键区别：
   * 加入已有文档时，本地在吃远端 SyncStep2 之前不创建任何嵌套类型，
   * 因此不可能与远端骨架产生 Yjs Map 键竞争。
   */
  integrateRemoteUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
    this.ensureInitialized();
  }

  /** 是否本地全新（尚无骨架）——同步层据此决定初始化策略 */
  get isFresh(): boolean {
    return !this.isInitialized;
  }

  /**
   * 底层 Y.Doc 是否已含文档 root 结构。
   * 与 isInitialized 的区别：即使 BlockDoc 包装层尚未 ensureInitialized，
   * 只要 IndexedDB 快照/远端增量已经把 root/order 写进了 Y.Doc，本方法就为 true。
   * 同步层据此区分"真正的全新文档"与"已加载本地基线的重连文档"。
   */
  get hasStoredStructure(): boolean {
    return this.root.has(K_ORDER) && this.root.has(K_BLOCKS);
  }

  /** Yjs state vector（SyncStep1） */
  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  /** 针对对端 state vector 计算增量（SyncStep2） */
  encodeDiff(stateVector?: Uint8Array): Uint8Array {
    return stateVector
      ? Y.encodeStateAsUpdate(this.doc, stateVector)
      : Y.encodeStateAsUpdate(this.doc);
  }
}

function sanitizeAttrs(attrs: InlineAttributes): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) out[k] = null; // null = 取消格式
    else out[k] = v;
  }
  return out;
}

function structuralEvent(e: Y.YEvent<any>): BlockEvent {
  if (e instanceof Y.YMapEvent) return { type: 'add' };
  return { type: 'move' };
}

/**
 * 新建文档：幂等初始化骨架并保证至少有一个可编辑段落。
 * 必须在接入网络前调用（若文档实际已有内容，ensureInitialized 为 no-op，
 * 仅在 order 为空时补段落）。
 */
export function createEmptyBlockDoc(doc?: Y.Doc, registry?: BlockRegistry): BlockDoc {
  const blockDoc = new BlockDoc(doc, registry);
  blockDoc.ensureInitialized();
  if (blockDoc.getBlockIds().length === 0) {
    // 初始空段落属于文档骨架：不进撤销栈，避免与首次输入被 UndoManager
    // 的 captureTimeout 合并后，一次撤销把首块连同文字一起删掉。
    blockDoc.createBlock({ type: 'paragraph' }, undefined, SETUP_ORIGIN);
  }
  return blockDoc;
}

/**
 * 从已持久化数据打开文档（调用方先把 IndexedDB 快照/远端 SyncStep2
 * applyUpdate 进来），随后调用本方法补齐缺失骨架。
 */
export function openLoadedBlockDoc(doc: Y.Doc, registry?: BlockRegistry): BlockDoc {
  const blockDoc = new BlockDoc(doc, registry);
  blockDoc.ensureInitialized();
  if (blockDoc.getBlockIds().length === 0) {
    blockDoc.createBlock({ type: 'paragraph' }, undefined, SETUP_ORIGIN);
  }
  return blockDoc;
}

/**
 * 打开一个"本地全新、等待远端快照"的文档（首次加入在线文档）：
 * 不创建任何骨架，等 integrateRemoteUpdate 合并到远端结构后再补；
 * 若远端也是空文档，则在首个上行时序由本地补骨架（见 SyncManager）。
 */
export function openFreshBlockDoc(doc: Y.Doc, registry?: BlockRegistry): BlockDoc {
  return new BlockDoc(doc, registry);
}

/** 仅供持久化层：把二进制 update 应用到一个临时 Y.Doc（无副作用） */
export function applyUpdateToDoc(doc: Y.Doc, update: Uint8Array, origin: unknown = REMOTE_ORIGIN): void {
  Y.applyUpdate(doc, update, origin);
}
