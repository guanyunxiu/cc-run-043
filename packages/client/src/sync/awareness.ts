import * as Y from 'yjs';
import type { AwarenessPresence } from '@coedit/shared';
import { withColor } from '@coedit/shared';

interface AwarenessEntryInternal {
  clock: number;
  /** 序列化的 JSON；null 表示"该 client 已移除状态" */
  json: string;
}

type Listener = (
  changed: Map<number, AwarenessPresence | null>,
  source: 'local' | 'remote',
) => void;

/**
 * 与 y-protocols/awareness 同语义的轻量实现：
 *  - 每个 clientId 维护单调递增 clock；
 *  - 状态体为 JSON（这里强类型为 AwarenessPresence）；
 *  - json === 'null' 表示删除；
 *  - 断线重连时通过快照（AwarenessSnapshot）一次性补齐房间全量状态。
 *
 * 我们在 wire 层使用自定义 protobuf 信封（见 @coedit/shared/protocol），
 * 状态合并/过期规则保持与官方 awareness 一致。
 */
export class Awareness {
  readonly clientId: number;
  private states = new Map<number, AwarenessEntryInternal>();
  private listeners = new Set<Listener>();

  constructor(doc: Y.Doc) {
    this.clientId = doc.clientID;
  }

  getLocal(): AwarenessPresence | null {
    const entry = this.states.get(this.clientId);
    if (!entry || entry.json === 'null') return null;
    return JSON.parse(entry.json) as AwarenessPresence;
  }

  setLocal(presence: AwarenessPresence | null): void {
    const prev = this.states.get(this.clientId);
    const clock = (prev?.clock ?? 0) + 1;
    this.states.set(this.clientId, { clock, json: presence ? JSON.stringify(presence) : 'null' });
    const changed = new Map([[this.clientId, presence]]);
    for (const cb of this.listeners) cb(changed, 'local');
  }

  /** 合并来自网络的一批条目；返回发生实际变化的 client 集合 */
  applyRemote(entries: Array<{ clientId: number; clock: number; json: string }>): Map<number, AwarenessPresence | null> {
    const changed = new Map<number, AwarenessPresence | null>();
    for (const e of entries) {
      const prev = this.states.get(e.clientId);
      if (prev && prev.clock >= e.clock) continue; // 旧消息丢弃
      this.states.set(e.clientId, { clock: e.clock, json: e.json });
      if (!prev || prev.json !== e.json) {
        const parsed: AwarenessPresence | null = e.json === 'null' ? null : JSON.parse(e.json);
        changed.set(e.clientId, parsed);
      }
    }
    if (changed.size) for (const cb of this.listeners) cb(changed, 'remote');
    return changed;
  }

  getStates(): Map<number, AwarenessPresence> {
    const out = new Map<number, AwarenessPresence>();
    for (const [id, e] of this.states) {
      if (e.json === 'null') continue;
      const parsed = JSON.parse(e.json) as AwarenessPresence;
      out.set(id, normalize(parsed));
    }
    return out;
  }

  /** 入房时发送的全量快照 */
  encodeSnapshot(): Array<{ clientId: number; clock: number; json: string }> {
    return [...this.states.entries()].map(([clientId, e]) => ({ clientId, clock: e.clock, json: e.json }));
  }

  /** 本地当前条目（增量广播用） */
  encodeLocalEntry(): Array<{ clientId: number; clock: number; json: string }> {
    const e = this.states.get(this.clientId);
    return e ? [{ clientId: this.clientId, clock: e.clock, json: e.json }] : [];
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 心跳：刷新时间戳，防止服务端将在线状态过期 */
  heartbeat(): void {
    const local = this.getLocal();
    if (local) this.setLocal({ ...local, t: Date.now() });
  }
}

function normalize(p: AwarenessPresence): AwarenessPresence {
  return { ...p, user: withColor(p.user) };
}
