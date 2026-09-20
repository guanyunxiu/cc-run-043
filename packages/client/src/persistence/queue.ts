import * as idb from './idb.js';
import type { PendingUpdateRecord, PendingUpdateReason, TempDocState } from '@coedit/shared';

/**
 * 离线待同步操作队列。
 * 关键性质：
 *  - 入队按内容指纹去重（同一 update 被重复捕获时不重复暂存）；
 *  - 出队确认（ack）按 id 删除，网络抖动重试天然幂等：
 *    CRDT 增量重复应用在服务端是无副作用的，重复暂存/推送也安全；
 *  - 保留 reason/retryCount，供指数退避与死信诊断。
 */
export class PendingUpdateQueue {
  async enqueue(
    docId: string,
    update: Uint8Array,
    reason: PendingUpdateReason = 'offline-edit',
  ): Promise<PendingUpdateRecord> {
    const fingerprint = await fingerprintUpdate(docId, update);
    const existing = await this.list(docId);
    if (existing.some((r) => r.docId === docId && r.fingerprint === fingerprint)) {
      return existing.find((r) => r.fingerprint === fingerprint)!;
    }
    const record: PendingUpdateRecord & { fingerprint: string } = {
      docId,
      update,
      reason,
      createdAt: Date.now(),
      retryCount: 0,
      fingerprint,
    };
    const id = (await idb.idbPut('pending', record)) as number;
    return { ...record, id };
  }

  async list(docId?: string): Promise<Array<PendingUpdateRecord & { fingerprint?: string }>> {
    const all = await idb.idbGetAll<PendingUpdateRecord & { fingerprint: string }>('pending');
    return docId ? all.filter((r) => r.docId === docId) : all;
  }

  async ack(ids: number[]): Promise<void> {
    if (ids.length) await idb.idbDelete('pending', ids);
  }

  async markRetry(ids: number[]): Promise<void> {
    for (const id of ids) {
      const row = await idb.idbGet<PendingUpdateRecord>('pending', id);
      if (row) {
        await idb.idbPut('pending', { ...row, retryCount: (row.retryCount ?? 0) + 1 });
      }
    }
  }

  async size(docId?: string): Promise<number> {
    const rows = await this.list(docId);
    return rows.length;
  }

  async clear(docId: string): Promise<void> {
    const rows = await this.list(docId);
    await this.ack(rows.map((r) => r.id!));
  }
}

/** 32 位内容指纹（FNV-1a），仅用于队列内幂等去重，非加密哈希 */
async function fingerprintUpdate(docId: string, update: Uint8Array): Promise<string> {
  let h = 0x811c9dc5;
  const mix = (b: number) => {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  };
  for (let i = 0; i < docId.length; i++) mix(docId.charCodeAt(i));
  mix(0);
  for (let i = 0; i < update.length; i++) mix(update[i]);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 临时文档状态（不入协同，仅本地 UI 体验） */
export class TempStateStore {
  async save(state: Omit<TempDocState, 'updatedAt'>): Promise<void> {
    await idb.idbPut('tempstate', { ...state, updatedAt: Date.now() });
  }

  async load(docId: string): Promise<TempDocState | undefined> {
    return idb.idbGet<TempDocState>('tempstate', docId);
  }
}
