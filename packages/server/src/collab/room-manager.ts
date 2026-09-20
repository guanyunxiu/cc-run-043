import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import {
  decodeAwareness,
  decodeEnvelope,
  decodeJoin,
  decodeSyncStep1,
  decodeSyncStep2,
  decodeUpdatePayload,
  encodeAwareness,
  encodeError,
  encodeJoin,
  encodeJoined,
  encodePong,
  encodeServerUpdate,
  encodeSyncStep2,
  ErrorCode,
  MsgType,
  type AwarenessEntry,
} from '@coedit/shared';
import { RoomStore } from './room-store.js';
import { PgService } from '../db/pg.service.js';
import { RedisService } from '../db/redis.service.js';

interface ClientConn {
  ws: WebSocket | null;
  docId: string | null;
  clientId: number;
  userId: string;
  /** 该连接上的 Yjs update 处理函数（用于广播时忽略自身） */
  docUpdateHandler: ((update: Uint8Array) => void) | null;
  redisUnsubscribe: (() => void) | null;
  closed: boolean;
  /** HTTP 长轮询虚拟连接的消息收件箱（cursor 单调递增） */
  inbox: PollInbox | null;
}

/** 长轮询收件箱：内存环形缓冲（按 clientId 隔离） */
interface PollInbox {
  messages: Array<{ cursor: number; data: Uint8Array }>;
  cursor: number;
  /** 等待中的长轮询请求 */
  waiters: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }>;
}

const POLL_WAIT_MS = 25_000;
const POLL_MAX_BUFFER = 1000;

/**
 * 房间连接管理（y-websocket 的二进制协同语义二次封装）。
 *
 * 消息流：
 *   client Join（docId/token/clientId/presence）
 *     → PgService 文档级权限校验（owner/write/read）
 *     → RoomStore 取得/恢复服务端 Y.Doc
 *     → 订阅本进程 doc 'update' → 广播 encodeServerUpdate 增量
 *     → Redis 订阅跨节点 relay（多实例部署时）
 *   client SyncStep1(stateVector) → encodeSyncStep2(仅缺失的增量)
 *   client Update（write 权限）→ applyUpdate 到服务端 doc
 *     → 持久化 + 广播（CRDT 保证幂等合并）
 *   client Awareness → Redis presence 缓存 + 广播
 */
@Injectable()
export class RoomManager {
  /** docId -> 房间内连接 */
  private rooms = new Map<string, Set<ClientConn>>();
  /**
   * 每个服务端 Y.Doc 仅挂一个更新广播监听器（Y.Doc 在 RoomStore 中按 docId 唯一）。
   * key 为 Y.Doc 实例本身。
   */
  private readonly serverDocListeners = new WeakMap<Y.Doc, (u: Uint8Array, origin: unknown) => void>();

  constructor(
    private readonly roomStore: RoomStore,
    private readonly pg: PgService,
    private readonly redis: RedisService,
  ) {}

  async handleConnection(ws: WebSocket, query: URLSearchParams): Promise<void> {
    const conn: ClientConn = {
      ws,
      docId: null,
      clientId: Number(query.get('clientId') ?? 0) >>> 0,
      userId: '',
      docUpdateHandler: null,
      redisUnsubscribe: null,
      closed: false,
      inbox: null,
    };

    ws.on('message', async (raw) => {
      try {
        const buf = Buffer.isBuffer(raw) ? new Uint8Array(raw) : new Uint8Array(raw as ArrayBuffer);
        const env = decodeEnvelope(buf);
        await this.dispatch(conn, env.type, env.payload);
      } catch (err) {
        this.sendError(conn, ErrorCode.BadPayload, (err as Error).message);
      }
    });

    ws.on('close', () => void this.leave(conn));
    ws.on('error', () => void this.leave(conn));
  }

  private async dispatch(
    conn: ClientConn,
    type: MsgType,
    payload: Uint8Array,
  ): Promise<void> {
    switch (type) {
      case MsgType.Ping:
        this.send(conn, encodePong());
        return;
      case MsgType.Join:
        await this.join(conn, decodeJoin(payload));
        return;
      default:
        break;
    }
    if (!conn.docId) {
      this.sendError(conn, ErrorCode.Unauthorized, 'not joined');
      return;
    }
    switch (type) {
      case MsgType.SyncStep1:
        await this.syncStep1(conn, decodeSyncStep1(payload));
        break;
      case MsgType.SyncStep2:
        // 客户端上行的初始全量/增量状态（y-websocket 双向握手），按写入处理
        await this.clientUpdate(conn, decodeSyncStep2(payload));
        break;
      case MsgType.Update:
        await this.clientUpdate(conn, decodeUpdatePayload(payload));
        break;
      case MsgType.Awareness:
        await this.awareness(conn, decodeAwareness(payload), false);
        break;
      case MsgType.Leave:
        await this.leave(conn);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------

  private async join(conn: ClientConn, join: ReturnType<typeof decodeJoin>): Promise<void> {
    const docId = join.docId;
    conn.docId = docId;
    conn.clientId = join.clientId >>> 0;
    const presenceJson = join.presence;
    let userId = `anon:${conn.clientId}`;
    try {
      const parsed = presenceJson ? JSON.parse(presenceJson) : null;
      if (parsed?.user?.id) userId = String(parsed.user.id);
    } catch { /* ignore */ }
    conn.userId = userId;

    // 权限校验：文档不存在则自动建档并授权 owner（首访即创建，开发体验）
    let level: 'read' | 'write' | 'owner' | null = await this.pg.resolvePermission(docId, userId);
    if (!level) {
      await this.pg.ensureDoc(docId, userId);
      level = 'owner';
    }
    const permissionCode = level === 'owner' ? 3 : level === 'write' ? 2 : 1;

    const doc = await this.roomStore.retain(docId);

    // 注册到房间
    let set = this.rooms.get(docId);
    if (!set) { set = new Set(); this.rooms.set(docId, set); }
    set.add(conn);

    // 服务端权威 Y.Doc 的每次更新只由一个监听器广播（在 join 时幂等挂载一次），
    // 来源连接通过事务 origin 标记，广播时据此排除（而不是每个连接各自排除自己）。
    if (!this.serverDocListeners.has(doc)) {
      this.serverDocListeners.set(doc, (update: Uint8Array, origin: unknown) => {
        const sourceConn =
          origin && typeof origin === 'object' && (origin as { __conn?: ClientConn }).__conn
            ? (origin as { __conn?: ClientConn }).__conn
            : undefined;
        this.broadcast(docId, encodeServerUpdate(update), sourceConn);
        void this.redis.relayToOtherInstances(docId, encodeServerUpdate(update));
      });
      doc.on('update', this.serverDocListeners.get(doc)!);
    }

    // 跨节点 relay（其它实例转发来的更新 → 本实例房间内全部连接）
    conn.redisUnsubscribe = await this.redis.subscribe(docId, (message) => {
      this.broadcast(docId, new Uint8Array(message));
    });

    this.send(conn, encodeJoined({ docId, permission: permissionCode }));

    // 入房 presence：写入 Redis 缓存并向房间广播
    if (presenceJson) {
      await this.redis.setPresence(docId, conn.clientId, presenceJson);
      await this.awareness(conn, [{ clientId: conn.clientId, clock: 1, json: presenceJson }], false);
    }
    // 下发房间内已有 presence 快照
    const all = await this.redis.getAllPresence(docId);
    const entries: AwarenessEntry[] = Object.entries(all).map(([cid, json]) => ({
      clientId: Number(cid) >>> 0,
      clock: 1,
      json,
    }));
    if (entries.length) this.send(conn, encodeAwareness(entries, true));
  }

  private async syncStep1(conn: ClientConn, stateVector: Uint8Array): Promise<void> {
    const doc = await this.roomStore.getRoom(conn.docId!);
    const diff = Y.encodeStateAsUpdate(doc, stateVector.length ? stateVector : undefined);
    this.send(conn, encodeSyncStep2(diff));
  }

  private async clientUpdate(conn: ClientConn, update: Uint8Array): Promise<void> {
    if (!update.length) return;
    // 权限：read 级拒绝写入
    const level = await this.pg.resolvePermission(conn.docId!, conn.userId);
    if (level === 'read') {
      this.sendError(conn, ErrorCode.Forbidden, 'read-only document');
      return;
    }
    const doc = await this.roomStore.getRoom(conn.docId!);
    // 应用到服务端权威 doc；origin 携带来源连接，供唯一广播监听器排除回显
    Y.applyUpdate(doc, update, { __conn: conn } as unknown as object);
  }

  private async awareness(conn: ClientConn, entries: AwarenessEntry[], _snapshot: boolean): Promise<void> {
    if (!conn.docId) return;
    for (const e of entries) {
      if (e.json === 'null') {
        await this.redis.removePresence(conn.docId, e.clientId);
      } else {
        await this.redis.setPresence(conn.docId, e.clientId, e.json);
      }
    }
    // 本实例内广播（除来源），再 relay 到其它实例
    const frame = encodeAwareness(entries);
    this.broadcast(conn.docId, frame, conn);
    await this.redis.relayToOtherInstances(conn.docId, frame);
  }

  private async leave(conn: ClientConn): Promise<void> {
    if (conn.closed || !conn.docId) return;
    conn.closed = true;
    const docId = conn.docId;
    const set = this.rooms.get(docId);
    set?.delete(conn);

    // 通知房间该 client 的 presence 已删除
    const frame = encodeAwareness([{ clientId: conn.clientId, clock: 0xffffffff, json: 'null' }]);
    this.broadcast(docId, frame, conn);
    await this.redis.removePresence(docId, conn.clientId).catch(() => undefined);
    await this.redis.relayToOtherInstances(docId, frame).catch(() => undefined);

    // Y.Doc 的广播监听器是房间级单例，不在连接离开时摘除
    // （最后一个连接离开时 RoomStore 会延迟销毁 doc，其监听器随 doc 一起回收）。
    this.roomStore.releaseRoom(docId);
    conn.redisUnsubscribe?.();
    try { conn.ws?.close(); } catch { /* ignore */ }
  }

  // -------------------------------------------------------------------------

  private broadcast(docId: string, frame: Uint8Array, except?: ClientConn): void {
    const set = this.rooms.get(docId);
    if (!set) return;
    for (const c of set) {
      if (c === except) continue;
      this.send(c, frame);
    }
  }

  private send(conn: ClientConn, data: Uint8Array): void {
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(data);
      return;
    }
    // HTTP 长轮询虚拟连接：写入收件箱并唤醒等待者
    if (conn.inbox) {
      const cursor = conn.inbox.cursor + 1;
      conn.inbox.cursor = cursor;
      conn.inbox.messages.push({ cursor, data });
      if (conn.inbox.messages.length > POLL_MAX_BUFFER) conn.inbox.messages.shift();
      const waiters = conn.inbox.waiters.splice(0);
      for (const w of waiters) { clearTimeout(w.timer); w.resolve(); }
    }
  }

  private sendError(conn: ClientConn, code: ErrorCode, message: string): void {
    this.send(conn, encodeError(code, message));
  }

  // ===========================================================================
  // HTTP 长轮询通道（WebSocket 降级）—— 与 WS 共用同一房间/Y.Doc/presence
  // ===========================================================================

  /** 长轮询入房：复用 Join 消息流程，随后等待数据 */
  async pollJoin(docId: string, clientId: number, presenceJson: string): Promise<void> {
    let conn = this.findPollConn(docId, clientId);
    if (!conn) {
      conn = {
        ws: null,
        docId: null,
        clientId,
        userId: '',
        docUpdateHandler: null,
        redisUnsubscribe: null,
        closed: false,
        inbox: { messages: [], cursor: 0, waiters: [] },
      };
    }
    const joinPayload = encodeJoin({
      docId, token: '', clientId, presence: presenceJson,
    });
    const env = decodeEnvelope(joinPayload);
    await this.dispatch(conn, env.type, env.payload);
  }

  /** 长轮询上行消息（Update / Awareness / SyncStep1） */
  async pollSend(docId: string, clientId: number, frame: Uint8Array): Promise<void> {
    const conn = this.findPollConn(docId, clientId);
    if (!conn) throw new Error('not joined');
    const env = decodeEnvelope(frame);
    await this.dispatch(conn, env.type, env.payload);
  }

  /**
   * 长轮询拉取：有消息立即返回；否则挂起至多 POLL_WAIT_MS。
   * 返回的 cursor 单调递增，客户端下次带上以实现增量读取。
   */
  async pollFetch(
    docId: string,
    clientId: number,
    afterCursor: number,
  ): Promise<{ cursor: number; messages: Uint8Array[] }> {
    const conn = this.findPollConn(docId, clientId);
    if (!conn) throw new Error('not joined');
    const inbox = conn.inbox!;

    const collect = () => inbox.messages.filter((m) => m.cursor > afterCursor);
    let pending = collect();
    if (pending.length === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, POLL_WAIT_MS);
        inbox.waiters.push({ resolve, timer });
      });
      pending = collect();
    }
    return {
      cursor: pending.length ? pending[pending.length - 1].cursor : afterCursor,
      messages: pending.map((m) => m.data),
    };
  }

  async pollLeave(docId: string, clientId: number): Promise<void> {
    const conn = this.findPollConn(docId, clientId);
    if (conn) await this.leave(conn);
  }

  private findPollConn(docId: string, clientId: number): ClientConn | undefined {
    const set = this.rooms.get(docId);
    if (!set) return undefined;
    for (const c of set) {
      if (!c.ws && c.clientId === clientId) return c;
    }
    return undefined;
  }
}
