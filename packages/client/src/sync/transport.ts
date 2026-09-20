import {
  decodeEnvelope,
  encodeEnvelope,
  MsgType,
  toBase64,
  fromBase64,
} from '@coedit/shared';

export interface TransportOptions {
  docId: string;
  token: string;
  clientId: number;
  /** WebSocket 基址，如 wss://host/coedit */
  wsUrl: string;
  /** HTTP 长轮询基址，如 https://host/api/rooms */
  httpUrl: string;
  /** 初始首选通道；默认 ws，连续失败自动降级 */
  preferred?: 'ws' | 'poll';
  onMessage: (data: Uint8Array) => void;
  onStatus: (status: 'connecting' | 'online' | 'offline') => void;
}

/**
 * 双通道传输：WebSocket 为主，HTTP 长轮询为降级。
 * 上层 SyncManager 只与本抽象交互，通道切换对协同逻辑透明。
 */
export interface RoomTransport {
  readonly kind: 'ws' | 'poll';
  start(): void;
  send(data: Uint8Array): void;
  close(): void;
}

export function createTransport(opts: TransportOptions): RoomTransport {
  return opts.preferred === 'poll'
    ? new PollingTransport(opts)
    : new WebSocketTransport(opts);
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

class WebSocketTransport implements RoomTransport {
  readonly kind = 'ws' as const;
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectDelay = 500;
  private failedAt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: TransportOptions) {}

  start(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    this.opts.onStatus('connecting');
    const url = new URL(this.opts.wsUrl);
    url.searchParams.set('docId', this.opts.docId);
    url.searchParams.set('token', this.opts.token);
    url.searchParams.set('clientId', String(this.opts.clientId));

    let ws: WebSocket;
    try {
      ws = new WebSocket(url.toString());
    } catch {
      this.fallback();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.reconnectDelay = 500;
      this.opts.onStatus('online');
      this.startPing();
      // SyncStep1 由 SyncManager 在 onStatus(online) 时发送
    };
    ws.onmessage = (ev) => {
      const data = ev.data instanceof ArrayBuffer
        ? new Uint8Array(ev.data)
        : fromBase64(String(ev.data));
      this.opts.onMessage(data);
    };
    ws.onerror = () => {
      // close 事件随后触发
      this.failedAt = Date.now();
    };
    ws.onclose = () => {
      this.stopPing();
      if (this.closed) return;
      this.opts.onStatus('offline');
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      // 短时间内反复失败 → 判定 WS 不可用，降级长轮询
      if (this.reconnectDelay >= 4000) {
        this.fallback();
        return;
      }
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 4000);
      this.open();
    }, this.reconnectDelay);
  }

  private fallback(): void {
    this.close();
    const poll = new PollingTransport(this.opts);
    poll.start();
    thisReplacement.swap(this.opts, poll);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      try {
        if (this.ws) this.ws.send(encodeEnvelope(MsgType.Ping, new Uint8Array(0)));
      } catch { /* ignore */ }
    }, 20_000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  send(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }
}

/**
 * WS 降级为长轮询时，需要把 SyncManager 持有的引用换成新 transport。
 * 通过可替换句柄实现（SyncManager 永远经由 handle 转发）。
 */
const replacementHandlers = new WeakMap<TransportOptions, (t: RoomTransport) => void>();
const thisReplacement = {
  swap(opts: TransportOptions, t: RoomTransport) {
    replacementHandlers.get(opts)?.(t);
  },
};
export function onTransportReplaced(
  opts: TransportOptions,
  cb: (t: RoomTransport) => void,
): void {
  replacementHandlers.set(opts, cb);
}

// ---------------------------------------------------------------------------
// HTTP 长轮询
// ---------------------------------------------------------------------------

class PollingTransport implements RoomTransport {
  readonly kind = 'poll' as const;
  private stopped = false;
  private cursor = 0;
  private pollInFlight = false;
  private started = false;

  constructor(private readonly opts: TransportOptions) {}

  start(): void {
    this.stopped = false;
    if (!this.started) {
      this.started = true;
      this.opts.onStatus('connecting');
      // join
      void fetch(this.endpoint('/join'), this.init({ method: 'POST' }))
        .then(() => this.opts.onStatus('online'))
        .then(() => this.loop())
        .catch(() => this.opts.onStatus('offline'));
    } else {
      this.opts.onStatus('online');
      void this.loop();
    }
  }

  private endpoint(path: string): string {
    const u = new URL(`${this.opts.httpUrl}/${this.opts.docId}/${path}`, window.location.origin);
    u.searchParams.set('clientId', String(this.opts.clientId));
    return u.toString();
  }

  private init(init: RequestInit): RequestInit {
    return {
      ...init,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        ...(init.headers ?? {}),
      },
    };
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (this.pollInFlight) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      this.pollInFlight = true;
      try {
        const u = new URL(this.endpoint('poll'));
        u.searchParams.set('cursor', String(this.cursor));
        const res = await fetch(u.toString(), this.init({ method: 'GET' }));
        if (!res.ok) {
          this.opts.onStatus('offline');
          await sleep(1500);
          this.opts.onStatus('connecting');
          continue;
        }
        this.opts.onStatus('online');
        const body = (await res.json()) as { cursor: number; messages: string[] };
        this.cursor = body.cursor;
        for (const b64 of body.messages) this.opts.onMessage(fromBase64(b64));
      } catch {
        this.opts.onStatus('offline');
        await sleep(1500);
        this.opts.onStatus('connecting');
      } finally {
        this.pollInFlight = false;
      }
    }
  }

  async send(data: Uint8Array): Promise<void> {
    try {
      await fetch(this.endpoint('send'), this.init({
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.opts.token}` },
        body: JSON.stringify({ message: toBase64(data) }),
      }));
    } catch {
      // 离线时交由 SyncManager 的待同步队列保证不丢
      this.opts.onStatus('offline');
    }
  }

  close(): void {
    this.stopped = true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { decodeEnvelope };
