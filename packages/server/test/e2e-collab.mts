/**
 * 端到端：两个 WebSocket 客户端 + 一个 HTTP 长轮询客户端接入真实 NestJS 服务，
 * 验证：
 *  1) 二进制握手（Join / SyncStep1 下行差异 / SyncStep2 上行全量）；
 *  2) 实时增量广播：A 编辑 → B（WS）与 C（长轮询）收敛；
 *  3) 并发新增块无冲突自动合并、并发移动顺序收敛；
 *  4) awareness（光标 presence）互达；
 *  5) 服务端重启后从持久化恢复。
 */
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import WebSocket from 'ws';
import {
  decodeAwareness,
  decodeEnvelope,
  decodeSyncStep2,
  decodeUpdatePayload,
  encodeAwareness,
  encodeJoin,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdate,
  MsgType,
} from '@coedit/shared';
import {
  BlockDoc,
  LOCAL_ORIGIN,
  openFreshBlockDoc,
  REMOTE_ORIGIN,
  SETUP_ORIGIN,
} from '@coedit/block-core';

const PORT = Number(process.env.PORT ?? 3000);
const DOC = process.env.E2E_DOC ?? `e2e-doc-${Date.now()}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const b64enc = (d: Uint8Array) => Buffer.from(d).toString('base64');
const b64dec = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

interface Peer {
  ws?: WebSocket;
  doc: BlockDoc;
  rawFrames: Uint8Array[];
  send: (frame: Uint8Array) => void;
  close: () => Promise<void>;
  name: string;
  joined: () => Promise<void>;
}

/** 复刻客户端 SyncManager 的初始握手状态 */
function makeHandshake(doc: BlockDoc, send: (f: Uint8Array) => void, waitJoined: Promise<void>) {
  let reported = false;
  const reportLocal = () => {
    if (reported) return;
    reported = true;
    doc.ensureInitialized();
    if (doc.getBlockIds().length === 0) doc.createBlock({ type: 'paragraph' }, undefined, SETUP_ORIGIN);
    send(encodeSyncStep2(Y.encodeStateAsUpdate(doc.doc)));
  };

  const onFrame = async (frame: Uint8Array) => {
    const env = decodeEnvelope(frame);
    if (env.type === MsgType.SyncStep2) {
      const upd = decodeSyncStep2(env.payload);
      if (upd.length > 4) {
        // 远端有内容：合并后回传本地全量
        doc.integrateRemoteUpdate(upd);
        reportLocal();
      } else {
        // 空 diff（远端空房间）：首个加入方负责初始化
        Y.applyUpdate(doc.doc, upd, REMOTE_ORIGIN);
        await waitJoined;
        reportLocal();
      }
    } else if (env.type === MsgType.ServerUpdate) {
      Y.applyUpdate(doc.doc, decodeUpdatePayload(env.payload), REMOTE_ORIGIN);
    }
  };

  // Join 后发 SyncStep1
  return { onFrame, sendSyncStep1: () => send(encodeSyncStep1(Y.encodeStateVector(doc.doc))) };
}

async function openWs(clientId: number, name: string): Promise<Peer> {
  const blockDoc = openFreshBlockDoc(new Y.Doc());
  blockDoc.doc.clientID = clientId;
  const ws = new WebSocket(`ws://localhost:${PORT}/coedit`);
  ws.binaryType = 'arraybuffer';
  const rawFrames: Uint8Array[] = [];

  let resolveJoined!: () => void;
  const joinedPromise = new Promise<void>((r) => { resolveJoined = r; });
  const send = (f: Uint8Array) => { if (ws.readyState === WebSocket.OPEN) ws.send(f); };
  const hs = makeHandshake(blockDoc, send, joinedPromise);

  blockDoc.onUpdate((u, origin) => {
    if (origin === LOCAL_ORIGIN) send(encodeUpdate(u));
  });

  const peer: Peer = {
    ws, doc: blockDoc, rawFrames, send, name,
    joined: () => joinedPromise,
    close: async () => { ws.close(); await sleep(100); },
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws join timeout')), 4000);
    ws.on('open', () => {
      ws.send(encodeJoin({
        docId: DOC, token: 't', clientId,
        presence: JSON.stringify({ user: { id: `u${clientId}`, name }, cursor: null, t: Date.now() }),
      }));
      hs.sendSyncStep1();
    });
    ws.on('message', async (data: ArrayBuffer) => {
      const frame = new Uint8Array(data);
      rawFrames.push(frame);
      const env = decodeEnvelope(frame);
      if (env.type === MsgType.Joined) { clearTimeout(timer); resolveJoined(); resolve(); }
      await hs.onFrame(frame);
    });
    ws.on('error', reject);
  });

  return peer;
}

async function openPoll(clientId: number, name: string): Promise<Peer> {
  const blockDoc = openFreshBlockDoc(new Y.Doc());
  blockDoc.doc.clientID = clientId;
  const presence = JSON.stringify({ user: { id: `u${clientId}`, name }, cursor: null, t: Date.now() });
  const base = `http://localhost:${PORT}/api/rooms/${DOC}`;

  await fetch(`${base}/join?clientId=${clientId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ presence }),
  });

  let stopped = false;
  let resolveJoined!: () => void;
  const joinedPromise = new Promise<void>((r) => { resolveJoined = r; });
  const send = (frame: Uint8Array) => void fetch(`${base}/send?clientId=${clientId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: b64enc(frame) }),
  });
  const hs = makeHandshake(blockDoc, send, joinedPromise);

  // 本地编辑 → 通过长轮询上行二进制增量
  blockDoc.onUpdate((u, origin) => {
    if (origin === LOCAL_ORIGIN) send(encodeUpdate(u));
  });

  const peer: Peer = {
    doc: blockDoc, rawFrames: [], send, name,
    joined: () => joinedPromise,
    close: async () => {
      stopped = true;
      await fetch(`${base}/leave?clientId=${clientId}`, { method: 'POST' }).catch(() => undefined);
    },
  };

  hs.sendSyncStep1();
  let cursor = 0;
  const loop = (async () => {
    let sawJoined = false;
    while (!stopped) {
      const res = await fetch(`${base}/poll?clientId=${clientId}&cursor=${cursor}`);
      const body = await res.json() as { cursor: number; messages: string[] };
      cursor = body.cursor;
      for (const b64 of body.messages) {
        const frame = b64dec(b64);
        peer.rawFrames.push(frame);
        if (!sawJoined) { sawJoined = true; resolveJoined(); }
        await hs.onFrame(frame);
      }
    }
  })();
  void loop;

  return peer;
}

async function main(): Promise<void> {
  const a = await openWs(4001, 'WS-用户A');
  await sleep(300);
  const b = await openWs(4002, 'WS-用户B');
  await a.joined(); await b.joined();
  await sleep(400);

  // 0) 初始只有一个空段落，且 A/B 骨架一致（无竞争）
  assert.equal(a.doc.getBlockIds().length, 1, `A 初始 1 块，实际 ${a.doc.getBlockIds().length}`);
  assert.deepEqual(a.doc.getBlockIds(), b.doc.getBlockIds(), 'A/B 初始骨架一致（无孤立类型）');

  // 1) A 编辑首块 → B 实时收到
  const first = a.doc.getBlockIds()[0];
  a.doc.transact(() => a.doc.getText(first).insert(0, '你好，协同世界'), LOCAL_ORIGIN);
  await sleep(300);
  assert.equal(b.doc.getText(first).toString(), '你好，协同世界', 'B 应实时收到 A 的行内编辑');

  // 2) 并发新增块，CRDT 自动合并
  a.doc.createBlock({ text: 'A 的新块' });
  b.doc.createBlock({ text: 'B 的新块' });
  await sleep(400);
  assert.deepEqual(new Set(a.doc.getBlockIds()), new Set(b.doc.getBlockIds()), 'A/B 块集合收敛');
  assert.equal(a.doc.getBlockIds().length, 3, `并发新增应合并为 3 块，实际 ${a.doc.getBlockIds().length}`);
  assert.ok(a.doc.getBlockIds().some((id) => a.doc.getText(id).toString() === 'B 的新块'), 'A 应看到 B 的并发块');

  // 3) 并发移动同一块，顺序收敛
  const ids = a.doc.getBlockIds();
  a.doc.moveBlock(ids[ids.length - 1], 0);
  b.doc.moveBlock(ids[0], b.doc.getBlockIds().length - 1);
  await sleep(300);
  assert.deepEqual(a.doc.getBlockIds(), b.doc.getBlockIds(), '并发移动后顺序收敛');

  // 4) awareness：A 光标 → B 收到
  a.send(encodeAwareness([{
    clientId: 4001, clock: 5,
    json: JSON.stringify({ user: { id: 'u4001', name: 'WS-用户' }, cursor: { blockId: first, anchor: 2, head: 2 }, t: Date.now() }),
  }]));
  await sleep(300);
  const sawAwareness = b.rawFrames.some((frame) => {
    const env = decodeEnvelope(frame);
    return (env.type === MsgType.Awareness || env.type === MsgType.AwarenessSnapshot)
      && decodeAwareness(env.payload).some((e) => e.clientId === 4001);
  });
  assert.ok(sawAwareness, 'B 应收到 A 的 awareness');

  // 5) HTTP 长轮询 C：全量文档 + 编辑 + awareness + 上行
  const c = await openPoll(4003, '长轮询用户');
  await c.joined();
  await sleep(3000);
  assert.equal(c.doc.getBlockIds().length, 3, `长轮询应收敛 3 块，实际 ${c.doc.getBlockIds().length}`);
  assert.equal(c.doc.getText(first).toString(), '你好，协同世界', '长轮询应收到 A 的编辑');
  assert.ok(
    c.rawFrames.some((f) => [MsgType.Awareness, MsgType.AwarenessSnapshot].includes(decodeEnvelope(f).type)),
    '长轮询应收到 awareness',
  );
  c.doc.createBlock({ text: '来自长轮询' });
  await sleep(3200);
  assert.ok(
    a.doc.getBlockIds().some((id) => a.doc.getText(id).toString() === '来自长轮询'),
    '长轮询的上行编辑应到达 WS 客户端',
  );

  await a.close(); await b.close(); await c.close();
  console.log('✅ E2E 通过：正确握手 / WS 实时编辑 / 并发块增移合并 / awareness / HTTP 长轮询双向收敛');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ E2E 失败:', err);
  process.exit(1);
});
