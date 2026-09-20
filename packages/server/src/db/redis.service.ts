import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

type RedisClient = InstanceType<typeof Redis>;
type RelayListener = (message: Buffer) => void;

/**
 * Redis 用途：
 *  1. 在线用户缓存：coedit:online:{docId} -> Hash(clientId -> presence JSON)，带 TTL；
 *  2. 跨节点 relay：多实例部署时通过 pub/sub 通道 coedit:relay:{docId}
 *     转发二进制消息（带实例 id 前缀，接收端丢弃同源消息，杜绝回环）；
 *  3. 临时光标状态（presence 内的 cursor）。
 *
 * Redis 不可用时降级为进程内 Map；此时 relay 为 no-op
 * （单机内 Yjs 广播已覆盖所有连接，无需再转发）。
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly instanceId = randomUUID();
  private pub: RedisClient | null = null;
  private sub: RedisClient | null = null;
  private readonly subscriptions = new Map<string, Set<RelayListener>>();
  private readonly localStore = new Map<string, Map<string, { json: string; expireAt: number }>>();
  readonly available: boolean = false;

  async onModuleInit(): Promise<void> {
    const makeClient = () =>
      new Redis({
        ...config.redis,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
    const candidate = makeClient();
    candidate.on('error', () => undefined);
    try {
      await withTimeout(candidate.connect(), 1500);
      this.pub = candidate;
      this.sub = candidate.duplicate();
      this.sub.on('error', () => undefined);
      await withTimeout(this.sub.connect(), 1500);
      (this as { available: boolean }).available = true;
      this.sub.on('message', (channel: string, message: string) => {
        const buf = Buffer.from(message, 'binary');
        // 信封：[36 字节实例 UUID][payload]；丢弃本实例自己发出的消息
        const origin = buf.subarray(0, 36).toString('utf8');
        if (origin === this.instanceId) return;
        this.subscriptions.get(channel)?.forEach((cb) => cb(buf.subarray(36)));
      });
      this.logger.log(`Redis 已连接（在线状态 / 跨节点广播）实例 ${this.instanceId.slice(0, 8)}`);
    } catch (err) {
      this.logger.warn(`Redis 不可用，降级为进程内状态：${(err as Error).message}`);
      candidate.disconnect();
      this.pub = null;
      this.sub = null;
    }
  }

  private channel(docId: string): string {
    return `coedit:relay:${docId}`;
  }

  private key(docId: string): string {
    return `coedit:online:${docId}`;
  }

  async subscribe(docId: string, cb: RelayListener): Promise<() => void> {
    const ch = this.channel(docId);
    let set = this.subscriptions.get(ch);
    if (!set) {
      set = new Set();
      this.subscriptions.set(ch, set);
      if (this.sub && this.available) await this.sub.subscribe(ch);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
    };
  }

  /**
   * 把消息转发给"其它实例"：
   *  - Redis 可用：发布带本实例 id 的信封；
   *  - Redis 不可用（单实例）：noop，避免与 Yjs 本地广播重复/回环。
   */
  async relayToOtherInstances(docId: string, data: Uint8Array): Promise<void> {
    if (!this.pub || !this.available) return;
    const envelope = Buffer.concat([Buffer.from(this.instanceId, 'utf8'), Buffer.from(data)]);
    await this.pub.publish(this.channel(docId), envelope.toString('binary'));
  }

  async setPresence(docId: string, clientId: number, json: string): Promise<void> {
    if (this.pub && this.available) {
      await this.pub.hset(this.key(docId), String(clientId), json);
      await this.pub.expire(this.key(docId), config.presenceTtlSeconds);
      return;
    }
    let m = this.localStore.get(docId);
    if (!m) { m = new Map(); this.localStore.set(docId, m); }
    m.set(String(clientId), { json, expireAt: Date.now() + config.presenceTtlSeconds * 1000 });
  }

  async removePresence(docId: string, clientId: number): Promise<void> {
    if (this.pub && this.available) {
      await this.pub.hdel(this.key(docId), String(clientId));
      return;
    }
    this.localStore.get(docId)?.delete(String(clientId));
  }

  async getAllPresence(docId: string): Promise<Record<string, string>> {
    if (this.pub && this.available) return this.pub.hgetall(this.key(docId));
    const now = Date.now();
    const m = this.localStore.get(docId);
    const out: Record<string, string> = {};
    if (m) {
      for (const [k, v] of m) {
        if (v.expireAt < now) m.delete(k);
        else out[k] = v.json;
      }
    }
    return out;
  }

  async onModuleDestroy(): Promise<void> {
    this.pub?.disconnect();
    this.sub?.disconnect();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('redis connect timeout')), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
