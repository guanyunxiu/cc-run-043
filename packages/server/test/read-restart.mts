/** 重启后由全新客户端加入，验证从持久化恢复的内容完整。 */
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import WebSocket from 'ws';
import {
  decodeEnvelope,
  decodeSyncStep2,
  encodeJoin,
  encodeSyncStep1,
  MsgType,
} from '@coedit/shared';
import { openFreshBlockDoc } from '@coedit/block-core';

const PORT = Number(process.env.PORT ?? 3800);
const DOC = 'restart-live';

const doc = openFreshBlockDoc(new Y.Doc());
const ws = new WebSocket(`ws://localhost:${PORT}/coedit`);
ws.binaryType = 'arraybuffer';

await new Promise<void>((resolve, reject) => {
  const failTimer = setTimeout(() => reject(new Error('read timeout')), 5000);
  ws.on('open', () => {
    ws.send(encodeJoin({
      docId: DOC, token: 't', clientId: 7777,
      presence: JSON.stringify({ user: { id: 'r', name: 'reader' }, cursor: null, t: 0 }),
    }));
    ws.send(encodeSyncStep1(Y.encodeStateVector(doc.doc)));
  });
  ws.on('message', (data: ArrayBuffer) => {
    const env = decodeEnvelope(new Uint8Array(data));
    if (env.type === MsgType.SyncStep2) {
      const u = decodeSyncStep2(env.payload);
      if (u.length > 4) doc.integrateRemoteUpdate(u);
    }
    if (env.type === MsgType.Joined) {
      setTimeout(() => { clearTimeout(failTimer); resolve(); }, 500);
    }
  });
});
ws.close();

const ids = doc.getBlockIds();
const texts = ids.map((id) => doc.getText(id).toString());
console.log('重启后恢复块数:', ids.length, JSON.stringify(texts));
assert.equal(ids.length, 2);
assert.ok(texts[0].includes('服务器重启后还在吗'));
assert.equal(texts[1], '第二块');
console.log('✅ 真实服务重启后，新客户端从持久化恢复完整文档');
process.exit(0);
