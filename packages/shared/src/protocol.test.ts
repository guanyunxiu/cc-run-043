import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeAwareness,
  decodeEnvelope,
  decodeError,
  decodeJoin,
  decodeSyncStep1,
  decodeUpdatePayload,
  encodeAwareness,
  encodeEnvelope,
  encodeError,
  encodeJoin,
  encodeSyncStep1,
  encodeUpdate,
  ErrorCode,
  fromBase64,
  MsgType,
  toBase64,
} from './index.js';

test('protobuf 信封往返：类型 + 任意二进制负载', () => {
  const payload = new Uint8Array([0, 127, 128, 255, 1, 2, 3]);
  const framed = encodeEnvelope(MsgType.Update, payload);
  const decoded = decodeEnvelope(framed);
  assert.equal(decoded.type, MsgType.Update);
  assert.deepEqual(decoded.payload, payload);
});

test('Join 字段往返（中文字符串、大 clientId）', () => {
  const framed = encodeJoin({
    docId: 'doc-文档-1',
    token: 'tok/abc=~',
    clientId: 4_000_000_000,
    presence: '',
  });
  const env = decodeEnvelope(framed);
  assert.equal(env.type, MsgType.Join);
  const join = decodeJoin(env.payload);
  assert.equal(join.docId, 'doc-文档-1');
  assert.equal(join.token, 'tok/abc=~');
  assert.equal(join.clientId, 4_000_000_000);
});

test('SyncStep1 stateVector 往返（含多字节长度）', () => {
  const sv = new Uint8Array(300).fill(7);
  const framed = encodeSyncStep1(sv);
  assert.equal(decodeEnvelope(framed).type, MsgType.SyncStep1);
  assert.deepEqual(decodeSyncStep1(decodeEnvelope(framed).payload), sv);
});

test('Update 二进制增量往返与确定性（幂等暂存的前提）', () => {
  const update = Uint8Array.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  const a = encodeUpdate(update);
  const b = encodeUpdate(update);
  assert.deepEqual(a, b);
  assert.deepEqual(decodeUpdatePayload(decodeEnvelope(a).payload), update);
});

test('Awareness 多条目 + snapshot 标记', () => {
  const entries = [
    { clientId: 1, clock: 3, json: '{"user":{"id":"u1"}}' },
    { clientId: 4_000_000_000, clock: 99, json: 'null' },
  ];
  const framed = encodeAwareness(entries, true);
  assert.equal(decodeEnvelope(framed).type, MsgType.AwarenessSnapshot);
  assert.deepEqual(decodeAwareness(decodeEnvelope(framed).payload), entries);
});

test('Error 编解码 + base64 长轮询包装', () => {
  const framed = encodeError(ErrorCode.Forbidden, '无权访问');
  const err = decodeError(decodeEnvelope(framed).payload);
  assert.equal(err.code, ErrorCode.Forbidden);
  assert.equal(err.message, '无权访问');

  const b64 = toBase64(framed);
  assert.deepEqual(fromBase64(b64), framed);
});
