import * as Y from 'yjs';
import type { BlockDoc } from '@coedit/block-core';
import { LOCAL_ORIGIN, SETUP_ORIGIN } from '@coedit/block-core';
import type {
  AwarenessPresence,
  ConnectionStatus,
  CursorState,
  UserInfo,
} from '@coedit/shared';
import {
  decodeAwareness,
  decodeEnvelope,
  decodeError,
  decodeSyncStep2,
  decodeUpdatePayload,
  encodeAwareness,
  encodeJoin,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdate,
  MsgType,
} from '@coedit/shared';
import { Awareness } from './awareness.js';
import {
  createTransport,
  onTransportReplaced,
  RoomTransport,
  TransportOptions,
} from './transport.js';
import { PendingUpdateQueue } from '../persistence/queue.js';

export interface SyncManagerOptions {
  doc: BlockDoc;
  docId: string;
  token: string;
  user: UserInfo;
  wsUrl: string;
  httpUrl: string;
  preferredTransport?: 'ws' | 'poll';
}

export interface SyncState {
  status: ConnectionStatus;
  transport: 'ws' | 'poll' | 'none';
  pendingCount: number;
  peers: Array<{ clientId: number; presence: AwarenessPresence | null }>;
}

type StateListener = (s: SyncState) => void;

/**
 * 协同同步编排：
 *
 *  离线编辑
 *    Y.Doc 事务（LOCAL_ORIGIN）→ 'update' 事件
 *      ├─ 在线：立即通过传输层发送 encodeUpdate(二进制增量)
 *      └─ 离线：写入 PendingUpdateQueue（IndexedDB 暂存）
 *
 *  网络恢复 / 重连
 *    Join → SyncStep1(stateVector)
 *      → 服务端 SyncStep2（缺失增量）本地 applyRemoteUpdate 自动合并
 *      → 按队列顺序幂等推送本地未同步更新（CRDT 重复应用无副作用）
 *      → 推送全量 awareness 快照
 *
 *  远端更新 / awareness
 *    二进制信封解码，ServerUpdate → applyUpdate(REMOTE_ORIGIN)，不进撤销栈。
 */
export class SyncManager {
  private readonly awareness: Awareness;
  private readonly pendingQueue = new PendingUpdateQueue();
  private transport: RoomTransport | null = null;
  private joined = false;
  private status: ConnectionStatus = 'idle';
  private transportKind: 'ws' | 'poll' | 'none' = 'none';
  private readonly stateListeners = new Set<StateListener>();
  private offlineUnbind: (() => void) | null = null;
  private flushInProgress = false;
  private cursor: CursorState | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reportedInitialState = false;
  /**
   * 构造时本地是否已有基线：
   *  - true：从 IndexedDB 加载过（重连/离线优先场景）→ 空 diff 时绝不发全量，
   *    本地编辑只通过 pending 队列/增量上报，避免旧快照覆盖他人；
   *  - false：本地全新（首次加入）→ 收到空 SyncStep2 说明是空房间首个创建者。
   */
  private readonly localHadBaseline: boolean;

  constructor(private readonly opts: SyncManagerOptions) {
    this.awareness = new Awareness(opts.doc.doc);
    // 用底层存储结构判断本地基线（IndexedDB 已加载时为 true），
    // 而非 BlockDoc 包装层的 isInitialized（fresh 文档此时可能尚未 ensureInitialized）。
    this.localHadBaseline = opts.doc.hasStoredStructure;
    this.awareness.setLocal({ user: opts.user, cursor: null, t: Date.now() });
  }

  getAwareness(): Awareness {
    return this.awareness;
  }

  onState(cb: StateListener): () => void {
    this.stateListeners.add(cb);
    cb(this.snapshot());
    return () => this.stateListeners.delete(cb);
  }

  async start(): Promise<void> {
    const { doc } = this.opts;

    // 本地更新：在线直发；离线入队
    doc.onUpdate((update, origin) => {
      if (origin !== LOCAL_ORIGIN) return; // 远端合并/setup 不回发
      if (this.isOnline()) {
        this.send(encodeUpdate(update));
      } else {
        void this.pendingQueue.enqueue(this.opts.docId, update);
        this.emit();
      }
    });

    // awareness 变化 → 广播
    this.awareness.onChange((changed, source) => {
      if (source === 'local' && this.isOnline()) {
        const entries = this.awareness.encodeLocalEntry();
        this.send(encodeAwareness(entries));
      }
      if (source === 'remote') this.emit();
    });

    // 浏览器离线/在线事件
    window.addEventListener('online', this.handleNetworkBack);
    window.addEventListener('offline', this.handleNetworkLost);

    this.openTransport();
  }

  setCursor(cursor: CursorState | null): void {
    this.cursor = cursor;
    this.awareness.setLocal({ user: this.opts.user, cursor, t: Date.now() });
  }

  dispose(): void {
    window.removeEventListener('online', this.handleNetworkBack);
    window.removeEventListener('offline', this.handleNetworkLost);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.transport?.close();
    this.transport = null;
    this.offlineUnbind?.();
  }

  // -------------------------------------------------------------------------
  // 传输生命周期
  // -------------------------------------------------------------------------

  private openTransport(): void {
    const tOpts: TransportOptions = {
      docId: this.opts.docId,
      token: this.opts.token,
      clientId: this.opts.doc.clientId,
      wsUrl: this.opts.wsUrl,
      httpUrl: this.opts.httpUrl,
      preferred: this.opts.preferredTransport,
      onMessage: (data) => this.handleMessage(data),
      onStatus: (s) => this.handleTransportStatus(s),
    };
    onTransportReplaced(tOpts, (next) => {
      this.transport = next;
      this.transportKind = next.kind;
      this.emit();
    });
    this.transport = createTransport(tOpts);
    this.transportKind = this.transport.kind;
    this.transport.start();
    this.emit();
  }

  private handleTransportStatus(s: 'connecting' | 'online' | 'offline'): void {
    if (s === 'online') {
      this.status = this.joined ? 'reconnecting' : 'connecting';
      void this.joinAndSync();
    } else if (s === 'offline') {
      this.status = 'offline';
      this.joined = false;
      this.emit();
    } else {
      this.status = this.status === 'online' ? 'reconnecting' : 'connecting';
      this.emit();
    }
  }

  private handleNetworkBack = (): void => {
    if (!this.transport || this.transportKind === 'none') this.openTransport();
    else { this.status = 'reconnecting'; this.emit(); void this.joinAndSync(); }
  };

  private handleNetworkLost = (): void => {
    this.status = 'offline';
    this.emit();
  };

  private isOnline(): boolean {
    return this.status === 'online' && !!this.transport;
  }

  // -------------------------------------------------------------------------
  // 握手 / 增量合并 / 离线队列重放
  // -------------------------------------------------------------------------

  private async joinAndSync(): Promise<void> {
    if (!this.transport) return;

    // 1) Join
    this.send(encodeJoin({
      docId: this.opts.docId,
      token: this.opts.token,
      clientId: this.opts.doc.clientId,
      presence: JSON.stringify(this.awareness.getLocal()),
    }));

    // 2) 先请求远端差异（SyncStep1）。
    //    离线优先但远端已有文档的场景：等服务端 SyncStep2 回来并合并后，
    //    再回传本地全量（在 handleMessage 的 SyncStep2 分支触发），
    //    避免"空房间双方在收到对方骨架前各自建块"的初始化竞争。
    this.send(encodeSyncStep1(Y.encodeStateVector(this.opts.doc.doc)));

    // 3) awareness 全量
    this.send(encodeAwareness(this.awareness.encodeSnapshot()));

    // 4) 本地待同步增量（离线编辑）：无论空/非空房间都幂等重放。
    //    是否需要"空房间首个创建者上报全量"由 handleMessage 在收到
    //    空 SyncStep2 时按 localHadBaseline 判定（无竞态，不依赖定时器）。
    await this.flushPending();

    this.joined = true;
    this.status = 'online';
    this.emit();

    this.startHeartbeat();
  }

  private async flushPending(): Promise<void> {
    if (this.flushInProgress) return;
    this.flushInProgress = true;
    try {
      const rows = await this.pendingQueue.list(this.opts.docId);
      for (const row of rows) {
        if (!this.isOnline()) break; // 推送途中再次离线 → 保留剩余队列
        this.send(encodeUpdate(row.update));
      }
      // 已在线且全部尝试发送：ack 清除。
      // 安全性：即使个别包在传输中丢失，SyncStep 握手（基于 state vector）
      // 也会在下次重连时把缺口补回来；CRDT 增量重复应用幂等。
      if (this.isOnline()) {
        await this.pendingQueue.ack(rows.map((r) => r.id!));
      }
    } finally {
      this.flushInProgress = false;
      this.emit();
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.awareness.heartbeat();
    }, 15_000);
  }

  private send(data: Uint8Array): void {
    if (!this.transport) return;
    // WS 与 poll 都实现了 send（poll 为 async），这里统一触发
    void (this.transport as unknown as { send: (d: Uint8Array) => void | Promise<void> }).send(data);
  }

  // -------------------------------------------------------------------------
  // 入站消息
  // -------------------------------------------------------------------------

  private handleMessage(frame: Uint8Array): void {
    let envelope;
    try {
      envelope = decodeEnvelope(frame);
    } catch {
      return;
    }
    switch (envelope.type) {
      case MsgType.Joined:
        this.status = 'online';
        this.emit();
        break;
      case MsgType.SyncStep2: {
        const update = decodeSyncStep2(envelope.payload);
        const hasRemotePayload = update.length > 4; // 空 diff 仅含 update 信封字节
        this.applyRemote(update);

        if (!hasRemotePayload && !this.localHadBaseline && !this.reportedInitialState) {
          // 空房间首个创建者：本地初始化骨架并上报全量，建立服务端权威状态。
          // 加锁防止 Joined 与 SyncStep2 乱序时重复执行。
          this.reportedInitialState = true;
          this.opts.doc.ensureInitialized();
          if (this.opts.doc.getBlockIds().length === 0) {
            this.opts.doc.createBlock({ type: 'paragraph' }, undefined, SETUP_ORIGIN);
          }
          this.send(encodeSyncStep2(Y.encodeStateAsUpdate(this.opts.doc.doc)));
        }
        // 远端有数据（加入已有文档）或本地有基线（重连）：
        // 绝不发全量快照（旧快照会覆盖他人内容），只靠 pending 增量合并。
        void this.flushPending();
        break;
      }
      case MsgType.ServerUpdate: {
        const update = decodeUpdatePayload(envelope.payload);
        this.applyRemote(update);
        break;
      }
      case MsgType.Awareness:
      case MsgType.AwarenessSnapshot: {
        const entries = decodeAwareness(envelope.payload);
        const changed = this.awareness.applyRemote(entries);
        if (changed.size) this.emit();
        break;
      }
      case MsgType.Pong:
        break;
      case MsgType.Error: {
        const { code, message } = decodeError(envelope.payload);
        // 1=Unauthorized / 2=Forbidden / 3=DocNotFound 视为致命态，交上层处理
        if (code === 1 || code === 2 || code === 3) {
          this.status = 'error';
          // eslint-disable-next-line no-console
          console.warn('[coedit] server error:', code, message);
        }
        this.emit();
        break;
      }
      default:
        break;
    }
  }

  private applyRemote(update: Uint8Array): void {
    if (!update.length) return;
    // 合并远端增量后幂等补骨架：加入已有文档时本地此前未建任何嵌套类型，无竞争
    this.opts.doc.integrateRemoteUpdate(update);
  }

  private snapshot(): SyncState {
    return {
      status: this.status,
      transport: this.transportKind,
      pendingCount: 0, // 异步计数在 emit 时刷新
      peers: [...this.awareness.getStates().entries()]
        .filter(([id]) => id !== this.awareness.clientId)
        .map(([clientId, presence]) => ({ clientId, presence })),
    };
  }

  private emit(): void {
    void this.pendingQueue.size(this.opts.docId).then((pendingCount) => {
      const s = { ...this.snapshot(), pendingCount };
      for (const cb of this.stateListeners) cb(s);
    });
  }
}
