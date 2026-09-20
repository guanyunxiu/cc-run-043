/**
 * 离线优先 E2E（真实模型）：
 *  1) A 在线建立文档；
 *  2) B 先在线同步一次（拿到一致骨架与块 id）；
 *  3) B 断网，继续本地编辑 —— 增量只入待同步队列，不发送；
 *  4) B 重连：SyncStep1 拉取断网期间 A 的变更并自动合并，再幂等重放本地 pending；
 *  5) A、B 收敛；离线编辑不丢失、不重复，断网期间双方并发编辑也能无冲突合并。
 */
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import WebSocket from 'ws';
import {
  decodeEnvelope,
  decodeSyncStep2,
  decodeUpdatePayload,
  encodeJoin,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdate,
  MsgType,
} from '@coedit/shared';
import {
  LOCAL_ORIGIN,
  openFreshBlockDoc,
  REMOTE_ORIGIN,
  SETUP_ORIGIN,
} from '@coedit/block-core';

const PORT = Number(process.env.PORT ?? 3000);
const DOC = `offline-doc-${Date.now()}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 可在"在线/离线"切换的最小客户端；离线时编辑只入 pending 队列 */
function makePeer(clientId: number, name: string) {
  const doc = openFreshBlockDoc(new Y.Doc());
  doc.doc.clientID = clientId;
  const pending: Uint8Array[] = [];
  const raw: Uint8Array[] = [];
  let ws: WebSocket | null = null;
  let online = false;
  let reported = false;

  const send = (f: Uint8Array) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(f);
  };
  const ensureSkeleton = () => {
    doc.ensureInitialized();
    if (doc.getBlockIds().length === 0) doc.createBlock({ type: 'paragraph' }, undefined, SETUP_ORIGIN);
  };

  doc.onUpdate((u, origin) => {
    if (origin !== LOCAL_ORIGIN) return;
    pending.push(u);
    if (online) send(encodeUpdate(u));
  });

  /** 联网/重连：Join → SyncStep1；Joined 表示房间就绪，SyncStep2 负责合并远端 */
  const connect = () =>
    new Promise<void>((resolve, reject) => {
      ws = new WebSocket(`ws://localhost:${PORT}/coedit`);
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => reject(new Error(`${name} connect timeout`)), 5000);
      let settled = false;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;

      const settleSoon = () => {
        if (settled) return;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          online = true;
          ensureSkeleton();
          // 仅"空房间首个创建者（且无任何本地待发）"上报全量；
          // 重连/已见远端内容者绝不发全量（旧快照会覆盖他人），只重放 pending 增量。
          if (!reported && !sawRemote && pending.length === 0) {
            reported = true;
            send(encodeSyncStep2(Y.encodeStateAsUpdate(doc.doc)));
          }
          for (const upd of pending) send(encodeUpdate(upd));
          clearTimeout(timer);
          resolve();
        }, 350);
      };
      let sawRemote = false;
      ws.on('open', () => {
        ws!.send(encodeJoin({
          docId: DOC, token: 't', clientId,
          presence: JSON.stringify({ user: { id: `u${clientId}`, name }, cursor: null, t: Date.now() }),
        }));
        ws!.send(encodeSyncStep1(Y.encodeStateVector(doc.doc)));
        settleSoon(); // 兜底：即使没有任何下行帧也能在宽限期后结束
      });
      ws.on('message', (data: ArrayBuffer) => {
        const env = decodeEnvelope(new Uint8Array(data));
        raw.push(new Uint8Array(data));
        if (env.type === MsgType.SyncStep2) {
          const u = decodeSyncStep2(env.payload);
          if (u.length > 4) { doc.integrateRemoteUpdate(u); sawRemote = true; }
          else Y.applyUpdate(doc.doc, u, REMOTE_ORIGIN);
        }
        if (env.type === MsgType.ServerUpdate) {
          Y.applyUpdate(doc.doc, decodeUpdatePayload(env.payload), REMOTE_ORIGIN);
          sawRemote = true;
        }
        if (env.type === MsgType.Joined) settleSoon();
        if (env.type === MsgType.SyncStep2 || env.type === MsgType.ServerUpdate) settleSoon();
      });
      ws.on('error', reject);
    });

  const disconnect = async () => {
    online = false;
    ws?.close();
    ws = null;
    await sleep(150);
  };

  return { doc, pending, connect, disconnect, raw, name };
}

async function main(): Promise<void> {
  // 1) A 建立文档
  const a = makePeer(6001, 'A');
  await a.connect();
  const first = a.doc.getBlockIds()[0];
  a.doc.transact(() => a.doc.getText(first).insert(0, '共享首块-'), LOCAL_ORIGIN);
  await sleep(300);

  // 2) B 首次在线同步
  const b = makePeer(6002, 'B');
  await b.connect();
  assert.deepEqual(new Set(a.doc.getBlockIds()), new Set(b.doc.getBlockIds()), '首次同步后骨架一致');
  assert.ok(b.doc.getText(first).toString().includes('共享首块-'), 'B 应读到 A 的内容');

  // 3) B 断网
  await b.disconnect();

  // 断网期间：A 继续在线编辑；B 同时离线编辑（并发）
  a.doc.transact(() => a.doc.getText(first).insert(a.doc.getText(first).length, 'A 在线追加'), LOCAL_ORIGIN);
  a.doc.createBlock({ text: 'A 在 B 离线时新增' });
  await sleep(200);

  b.doc.transact(() => b.doc.getText(first).insert(b.doc.getText(first).length, 'B 离线追加'), LOCAL_ORIGIN);
  b.doc.createBlock({ text: 'B 离线下新增块' });
  console.log('B 离线 pending 增量条数:', b.pending.length);

  // 4) B 重连：合并断网期间 A 的变更 + 幂等重放本地 pending
  await b.connect();
  await sleep(500);

  const aTexts = a.doc.getBlockIds().map((id) => a.doc.getText(id).toString());
  const bTexts = b.doc.getBlockIds().map((id) => b.doc.getText(id).toString());
  console.log('A:', JSON.stringify(aTexts));
  console.log('B:', JSON.stringify(bTexts));

  // 5) 收敛与无冲突合并
  assert.deepEqual(new Set(a.doc.getBlockIds()), new Set(b.doc.getBlockIds()), '块集合收敛');
  assert.ok(aTexts.some((t) => t.includes('A 在线追加')), 'A 在线编辑保留');
  assert.ok(aTexts.some((t) => t === 'A 在 B 离线时新增'), 'A 离线期新增块到达 B');
  assert.ok(aTexts.some((t) => t.includes('B 离线追加')), 'B 离线编辑到达 A');
  assert.ok(aTexts.some((t) => t === 'B 离线下新增块'), 'B 离线新增块到达 A');
  const firstText = aTexts.find((t) => t.includes('共享首块-'))!;
  assert.ok(firstText.includes('A 在线追加') && firstText.includes('B 离线追加'), '并发追加在同一块自动合并');

  // 幂等：再重放一次 B 的 pending，最终文本不得重复（新客户端 C 读到的权威状态）
  for (const upd of b.pending) {
    // 模拟同一批 pending 被重复投递（网络抖动）
    const cWs = new WebSocket(`ws://localhost:${PORT}/coedit`);
    cWs.binaryType = 'arraybuffer';
    // 直接通过 B 连接再发一次更接近真实；这里用 B 已重连的 socket
    void cWs;
  }
  // 让 B 再发一遍同样的 pending 字节
  await b.disconnect();
  await b.connect(); // 重连会再次重放全部 pending（幂等）
  await sleep(400);
  const aTexts2 = a.doc.getBlockIds().map((id) => a.doc.getText(id).toString());
  const ft2 = aTexts2.find((t) => t.includes('共享首块-'))!;
  assert.equal(
    (ft2.match(/B 离线追加/g) ?? []).length,
    1,
    '重复重放不得产生重复文本（幂等）',
  );
  assert.deepEqual(new Set(a.doc.getBlockIds()), new Set(b.doc.getBlockIds()), '重放后仍收敛');

  await a.disconnect();
  await b.disconnect();
  console.log('✅ 断网全量编辑 → 重连自动合并 + 幂等重放，并发无冲突、内容不丢失不重复');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ 离线 E2E 失败:', err);
  process.exit(1);
});
