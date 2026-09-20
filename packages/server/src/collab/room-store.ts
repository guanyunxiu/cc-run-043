import { Injectable, Logger } from '@nestjs/common';
import * as Y from 'yjs';
import { YPersistenceService } from './y-persistence.service.js';

/**
 * Yjs 文档房间的内存宿主。
 * 这是对 y-websocket 服务端语义的二次封装：
 *  - 每个 docId 一个内存 Y.Doc（协作热点，常驻）；
 *  - 编辑增量实时持久化为 Yjs 二进制 update（YPersistenceService）；
 *  - SyncStep1/SyncStep2 握手、增量广播逻辑与 y-websocket 等价，
 *    但消息信封换成自定义的 y-protobuf 兼容二进制协议。
 */
interface RoomEntry {
  doc: Y.Doc;
  refCount: number;
  destroyTimer: ReturnType<typeof setTimeout> | null;
  onUpdate: (update: Uint8Array) => void;
}

const DESTROY_AFTER_MS = 60_000;

@Injectable()
export class RoomStore {
  private readonly logger = new Logger(RoomStore.name);
  private rooms = new Map<string, RoomEntry>();

  constructor(private readonly persistence: YPersistenceService) {}

  /**
   * 获取（或从持久化恢复）房间文档。
   * 幂等：同一房间多次获取返回同一 Y.Doc，不改变引用计数
   * （引用计数只在 join / leave 时通过 retain/release 维护）。
   */
  async getRoom(docId: string): Promise<Y.Doc> {
    const existing = this.rooms.get(docId);
    if (existing) {
      if (existing.destroyTimer) {
        clearTimeout(existing.destroyTimer);
        existing.destroyTimer = null;
      }
      return existing.doc;
    }

    const doc = await this.persistence.loadDoc(docId, new Y.Doc());

    const entry: RoomEntry = {
      doc,
      refCount: 0,
      destroyTimer: null,
      onUpdate: (update: Uint8Array) => {
        void this.persistence.storeUpdate(docId, update).catch(() => undefined);
      },
    };
    doc.on('update', entry.onUpdate);
    this.rooms.set(docId, entry);
    this.logger.debug(`房间 ${docId} 已加载（内存房间数 ${this.rooms.size}）`);
    return doc;
  }

  /** 新连接加入房间，引用计数 +1 */
  async retain(docId: string): Promise<Y.Doc> {
    const doc = await this.getRoom(docId);
    this.rooms.get(docId)!.refCount += 1;
    return doc;
  }

  /** 连接离开：引用计数 -1；归零后延迟卸载内存 doc（频繁重连避免抖动） */
  releaseRoom(docId: string): void {
    const entry = this.rooms.get(docId);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount === 0) {
      entry.destroyTimer = setTimeout(() => {
        const current = this.rooms.get(docId);
        if (current && current.refCount === 0) {
          void this.persistence.checkpointFromDoc(docId, current.doc).catch(() => undefined);
          current.doc.off('update', current.onUpdate);
          current.doc.destroy();
          this.rooms.delete(docId);
        }
      }, DESTROY_AFTER_MS);
    }
  }
}
