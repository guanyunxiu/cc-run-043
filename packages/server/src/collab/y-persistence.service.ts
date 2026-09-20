import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as Y from 'yjs';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Yjs 服务端持久化（自包含，无原生 level 依赖）：
 *
 *  dataDir/
 *    {docId}.updates   追加写入的 Yjs 二进制 update 序列（4 字节大端长度 + payload）
 *    {docId}.snapshot  压缩后的全量 encodeStateAsUpdate
 *
 * 语义与 y-leveldb / y-indexeddb 完全一致：
 *  - storeUpdate 追加增量；
 *  - 恢复时按顺序 applyUpdate；
 *  - 累积到阈值做 snapshot checkpoint 并截断增量。
 *
 * 生产环境可将本类替换为对象存储 / PostgreSQL bytea 实现，接口保持不变。
 */
@Injectable()
export class YPersistenceService {
  private readonly logger = new Logger(YPersistenceService.name);
  private readonly dir: string;
  private readonly flushChain = new Map<string, Promise<void>>();
  private static readonly COMPACT_AT = 500;
  private counters = new Map<string, number>();

  constructor() {
    this.dir = process.env.YJS_DATA_DIR ?? './.coedit-data';
  }

  async onModuleInit(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true }).catch(() => undefined);
    this.logger.log(`Yjs 二进制持久化目录：${this.dir}`);
  }

  private safeName(docId: string): string {
    return docId.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  private updatesPath(docId: string): string {
    return path.join(this.dir, `${this.safeName(docId)}.updates`);
  }

  private snapshotPath(docId: string): string {
    return path.join(this.dir, `${this.safeName(docId)}.snapshot`);
  }

  /** 追加一条增量（串行化，避免并发写交错） */
  async storeUpdate(docId: string, update: Uint8Array): Promise<void> {
    const prev = this.flushChain.get(docId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(update.length, 0);
      await fs.appendFile(this.updatesPath(docId), Buffer.concat([header, Buffer.from(update)]));
      const n = (this.counters.get(docId) ?? 0) + 1;
      this.counters.set(docId, n);
      if (n >= YPersistenceService.COMPACT_AT) {
        this.counters.set(docId, 0);
        await this.checkpoint(docId).catch(() => undefined);
      }
    });
    this.flushChain.set(docId, next);
    await next.catch(() => undefined);
  }

  /** 读取快照 + 增量，恢复一个 Y.Doc 的完整状态 */
  async loadDoc(docId: string, doc = new Y.Doc()): Promise<Y.Doc> {
    const snapshot = await fs.readFile(this.snapshotPath(docId)).catch(() => null);
    if (snapshot) Y.applyUpdate(doc, new Uint8Array(snapshot));

    const buf = await fs.readFile(this.updatesPath(docId)).catch(() => null);
    if (buf) {
      let offset = 0;
      while (offset + 4 <= buf.length) {
        const len = buf.readUInt32BE(offset);
        offset += 4;
        if (offset + len > buf.length) break;
        Y.applyUpdate(doc, new Uint8Array(buf.subarray(offset, offset + len)));
        offset += len;
      }
    }
    return doc;
  }

  /** 用传入 doc 的全量状态生成快照并清空增量文件 */
  async checkpointFromDoc(docId: string, doc: Y.Doc): Promise<void> {
    const state = Y.encodeStateAsUpdate(doc);
    await fs.writeFile(this.snapshotPath(docId), Buffer.from(state));
    await fs.writeFile(this.updatesPath(docId), Buffer.alloc(0));
    this.counters.set(docId, 0);
  }

  /** 从已持久化数据重放后做快照（房间销毁时调用） */
  private async checkpoint(docId: string): Promise<void> {
    const restored = await this.loadDoc(docId);
    await this.checkpointFromDoc(docId, restored);
    restored.destroy();
  }
}
