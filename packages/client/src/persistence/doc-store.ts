import * as Y from 'yjs';
import * as idb from './idb.js';

interface UpdateRow {
  id?: number;
  docId: string;
  update: Uint8Array;
}

interface SnapshotRow {
  docId: string;
  state: Uint8Array;
  stateVector: Uint8Array;
  compactedAt: number;
}

/**
 * Yjs 文档本地持久化（y-indexeddb 同构语义，自包含实现）：
 *
 *  1. 启动：把 snapshots[docId] 与 updates(by docId) 按时间顺序 applyUpdate
 *     到一个 Y.Doc → 得到离线前完整状态；
 *  2. 运行：订阅 doc 'update' 事件，把每个二进制增量追加进 updates；
 *  3. 压缩：累积超过阈值（默认 200 行）时，用 encodeStateAsUpdate 生成
 *     全量快照写 snapshots，随后在同一 IndexedDB 事务中清空旧 updates。
 *
 * 所有编辑（在线/离线）都先落本地，形成"离线优先"保证。
 */
export class YjsDocStore {
  private static readonly COMPACT_AT = 200;
  private listeners = new Set<(docId: string, update: Uint8Array) => void>();

  /**
   * 加载本地状态到给定 Y.Doc。
   * @returns 是否存在任何本地数据
   */
  async loadInto(docId: string, doc: Y.Doc): Promise<boolean> {
    const [snapshot, updates] = await Promise.all([
      idb.idbGet<SnapshotRow>('snapshots', docId),
      idb.idbGetAllByIndex<UpdateRow>('updates', 'docId', docId),
    ]);
    if (snapshot) Y.applyUpdate(doc, snapshot.state);
    const sorted = updates.sort((a, b) => (a.id! < b.id! ? -1 : 1));
    for (const row of sorted) Y.applyUpdate(doc, row.update);
    return !!snapshot || sorted.length > 0;
  }

  /** 订阅 doc 更新并持久化。返回取消函数。 */
  bind(docId: string, doc: Y.Doc): () => void {
    const handler = (update: Uint8Array) => {
      void this.persist(docId, update);
      for (const cb of this.listeners) cb(docId, update);
    };
    doc.on('update', handler);
    return () => doc.off('update', handler);
  }

  /** 立即写入一条增量（幂等层在调用前做去重；此处只负责落盘） */
  async persist(docId: string, update: Uint8Array): Promise<number> {
    const key = await idb.idbPut<UpdateRow>('updates', { docId, update });
    void this.maybeCompact(docId);
    return key as number;
  }

  /** 用外部全量状态重置本地（比如服务端要求以远端为准时） */
  async replaceWith(docId: string, state: Uint8Array): Promise<void> {
    const updates = await idb.idbGetAllByIndex<UpdateRow>('updates', 'docId', docId);
    await idb.idbDelete('updates', updates.map((u) => u.id!));
    await idb.idbPut<SnapshotRow>('snapshots', {
      docId,
      state,
      stateVector: Y.encodeStateVectorFromUpdate(state),
      compactedAt: Date.now(),
    });
  }

  /** 主动把当前 doc 全量状态压成快照并清理增量（应用启动/关闭时调用） */
  async compact(docId: string, doc: Y.Doc): Promise<void> {
    const state = Y.encodeStateAsUpdate(doc);
    const updates = await idb.idbGetAllByIndex<UpdateRow>('updates', 'docId', docId);
    await idb.idbPut<SnapshotRow>('snapshots', {
      docId,
      state,
      stateVector: Y.encodeStateVector(doc),
      compactedAt: Date.now(),
    });
    await idb.idbDelete('updates', updates.map((u) => u.id!));
  }

  onUpdate(cb: (docId: string, update: Uint8Array) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private async maybeCompact(docId: string): Promise<void> {
    const count = await idb.idbCountByIndex('updates', 'docId', docId);
    if (count < YjsDocStore.COMPACT_AT) return;
    // 为压缩临时构造 doc：读快照+增量 → 全量 → 清增量
    const tmp = new Y.Doc();
    await this.loadInto(docId, tmp);
    const state = Y.encodeStateAsUpdate(tmp);
    const updates = await idb.idbGetAllByIndex<UpdateRow>('updates', 'docId', docId);
    await idb.idbPut<SnapshotRow>('snapshots', {
      docId,
      state,
      stateVector: Y.encodeStateVector(tmp),
      compactedAt: Date.now(),
    });
    await idb.idbDelete('updates', updates.map((u) => u.id!));
    tmp.destroy();
  }
}
