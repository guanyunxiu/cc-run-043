/**
 * 文档房间二进制协议（WebSocket / HTTP 长轮询共用同一信封）。
 *
 * 外层信封：
 *   Envelope { uint32 type = 1; bytes payload = 2; }
 *
 * Yjs 同步部分的字段布局对齐 y-protobuf：
 *   SyncStep1 { bytes stateVector = 1 }
 *   SyncStep2 { bytes update = 1 }
 *   Update    { bytes update = 1 }   —— 二进制增量更新，替代全量文本
 *
 * Awareness 以 protobuf 结构化传输，状态体为 JSON（y-protocols 兼容语义：
 * clock 单调递增，json === 'null' 表示删除该客户端状态）。
 */
import {
  PbReader,
  PbWriter,
  allBytes,
  firstBytes,
  firstString,
  firstUint,
} from './pb-codec.js';

export enum MsgType {
  // client -> server
  Join = 1,
  SyncStep1 = 2,
  Update = 3,
  Awareness = 4,
  Ping = 5,
  Leave = 6,
  // server -> client
  Joined = 10,
  SyncStep2 = 11,
  AwarenessSnapshot = 12, // 入房时全量 presence（同样使用 Awareness 负载）
  Error = 13,
  Pong = 14,
  ServerUpdate = 15, // 广播自其他客户端的 Update
}

export enum ErrorCode {
  Unauthorized = 1,
  Forbidden = 2,
  DocNotFound = 3,
  BadPayload = 4,
  Internal = 5,
}

// ---------------------------------------------------------------------------
// 编解码
// ---------------------------------------------------------------------------

export function encodeEnvelope(type: MsgType, payload: Uint8Array): Uint8Array {
  return new PbWriter()
    .writeUint32(1, type)
    .writeBytes(2, payload)
    .finish();
}

export interface DecodedEnvelope {
  type: MsgType;
  payload: Uint8Array;
}

export function decodeEnvelope(data: Uint8Array): DecodedEnvelope {
  const fields = new PbReader(data).readFields();
  const type = firstUint(fields, 1);
  const payload = firstBytes(fields, 2) ?? new Uint8Array(0);
  if (type === undefined) throw new Error('envelope: missing type');
  return { type, payload };
}

// -- Join / Joined -----------------------------------------------------------

export interface JoinPayload {
  docId: string;
  token: string;
  clientId: number;
  /** 序列化后的 AwarenessPresence（可空字符串） */
  presence: string;
}

export function encodeJoin(p: JoinPayload): Uint8Array {
  const w = new PbWriter()
    .writeString(1, p.docId)
    .writeString(2, p.token)
    .writeUint32(3, p.clientId >>> 0);
  if (p.presence) w.writeString(4, p.presence);
  return encodeEnvelope(MsgType.Join, w.finish());
}

export function decodeJoin(data: Uint8Array): JoinPayload {
  const f = new PbReader(data).readFields();
  return {
    docId: firstString(f, 1) ?? '',
    token: firstString(f, 2) ?? '',
    clientId: firstUint(f, 3) ?? 0,
    presence: firstString(f, 4) ?? '',
  };
}

export interface JoinedPayload {
  docId: string;
  permission: number;
}

export function encodeJoined(p: JoinedPayload): Uint8Array {
  const w = new PbWriter().writeString(1, p.docId).writeUint32(2, p.permission);
  return encodeEnvelope(MsgType.Joined, w.finish());
}

export function decodeJoined(data: Uint8Array): JoinedPayload {
  const f = new PbReader(data).readFields();
  return { docId: firstString(f, 1) ?? '', permission: firstUint(f, 2) ?? 0 };
}

// -- Yjs sync / update --------------------------------------------------------

export function encodeSyncStep1(stateVector: Uint8Array): Uint8Array {
  return encodeEnvelope(MsgType.SyncStep1, new PbWriter().writeBytes(1, stateVector).finish());
}

export function decodeSyncStep1(data: Uint8Array): Uint8Array {
  return firstBytes(new PbReader(data).readFields(), 1) ?? new Uint8Array(0);
}

export function encodeSyncStep2(update: Uint8Array): Uint8Array {
  return encodeEnvelope(MsgType.SyncStep2, new PbWriter().writeBytes(1, update).finish());
}

/** 客户端上行的增量更新 */
export function encodeUpdate(update: Uint8Array): Uint8Array {
  return encodeEnvelope(MsgType.Update, new PbWriter().writeBytes(1, update).finish());
}

/** 服务端广播的增量更新（与 encodeUpdate 负载同构） */
export function encodeServerUpdate(update: Uint8Array): Uint8Array {
  return encodeEnvelope(MsgType.ServerUpdate, new PbWriter().writeBytes(1, update).finish());
}

export function decodeUpdatePayload(data: Uint8Array): Uint8Array {
  return firstBytes(new PbReader(data).readFields(), 1) ?? new Uint8Array(0);
}

export function decodeSyncStep2(data: Uint8Array): Uint8Array {
  return decodeUpdatePayload(data);
}

// -- Awareness ----------------------------------------------------------------

export interface AwarenessEntry {
  clientId: number;
  clock: number;
  /** JSON 字符串；'null' 表示状态被移除 */
  json: string;
}

export function encodeAwareness(
  entries: AwarenessEntry[],
  snapshot = false,
): Uint8Array {
  const w = new PbWriter();
  for (const e of entries) {
    const entry = new PbWriter()
      .writeUint32(1, e.clientId >>> 0)
      .writeUint32(2, e.clock >>> 0)
      .writeString(3, e.json)
      .finish();
    w.writeBytes(1, entry); // repeated AwarenessUpdateEntry
  }
  return encodeEnvelope(snapshot ? MsgType.AwarenessSnapshot : MsgType.Awareness, w.finish());
}

export function decodeAwareness(data: Uint8Array): AwarenessEntry[] {
  const f = new PbReader(data).readFields();
  return allBytes(f, 1).map((raw) => {
    const ef = new PbReader(raw).readFields();
    return {
      clientId: firstUint(ef, 1) ?? 0,
      clock: firstUint(ef, 2) ?? 0,
      json: firstString(ef, 3) ?? 'null',
    };
  });
}

// -- 其它 ---------------------------------------------------------------------

export function encodePing(): Uint8Array {
  return encodeEnvelope(MsgType.Ping, new Uint8Array(0));
}

export function encodePong(): Uint8Array {
  return encodeEnvelope(MsgType.Pong, new Uint8Array(0));
}

export function encodeLeave(): Uint8Array {
  return encodeEnvelope(MsgType.Leave, new Uint8Array(0));
}

export function encodeError(code: ErrorCode, message: string): Uint8Array {
  return encodeEnvelope(
    MsgType.Error,
    new PbWriter().writeUint32(1, code).writeString(2, message).finish(),
  );
}

export function decodeError(data: Uint8Array): { code: ErrorCode; message: string } {
  const f = new PbReader(data).readFields();
  return { code: firstUint(f, 1) ?? 0, message: firstString(f, 2) ?? '' };
}

/** 长轮询通道中的 base64 包装（HTTP JSON 通道无法直接传裸二进制） */
export function toBase64(data: Uint8Array): string {
  let bin = '';
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
