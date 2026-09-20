/** 向重启测试文档写入固定内容（含行内文本 + 额外块）。 */
import * as Y from 'yjs';
import WebSocket from 'ws';
import {
  decodeEnvelope,
  decodeSyncStep2,
  encodeJoin,
  encodeSyncStep1,
  encodeUpdate,
  MsgType,
} from '@coedit/shared';
import { LOCAL_ORIGIN, openFreshBlockDoc, SETUP_ORIGIN } from '@coedit/block-core';

const PORT = Number(process.env.PORT ?? 3700);
const DOC = 'restart-live';

const doc = openFreshBlockDoc(new Y.Doc());
const ws = new WebSocket(`ws://localhost:${PORT}/coedit`);
ws.binaryType = 'arraybuffer';

await new Promise<void>((resolve, reject) => {
  const failTimer = setTimeout(() => reject(new Error('seed timeout')), 5000);
  let sent = false;

  ws.on('open', () => {
    ws.send(encodeJoin({
      docId: DOC, token: 't', clientId: 7001,
      presence: JSON.stringify({ user: { id: 'u', name: 'seed' }, cursor: null, t: 0 }),
    }));
    ws.send(encodeSyncStep1(Y.encodeStateVector(doc.doc)));
  });

  ws.on('message', (data: ArrayBuffer) => {
    const env = decodeEnvelope(new Uint8Array(data));
    if (env.type !== MsgType.SyncStep2) return;
    const u = decodeSyncStep2(env.payload);
    if (u.length > 4) {
      doc.integrateRemoteUpdate(u);
      return;
    }
    Y.applyUpdate(doc.doc, u);
    if (sent) return;
    sent = true;

    doc.ensureInitialized();
    if (doc.getBlockIds().length === 0) {
      doc.createBlock({ type: 'paragraph' }, undefined, SETUP_ORIGIN);
    }
    doc.transact(() => {
      doc.getText(doc.getBlockIds()[0]).insert(0, '服务器重启后还在吗');
    }, LOCAL_ORIGIN);
    doc.createBlock({ text: '第二块' });
    ws.send(encodeUpdate(Y.encodeStateAsUpdate(doc.doc)));
    setTimeout(() => { clearTimeout(failTimer); resolve(); }, 700);
  });
});

ws.close();
console.log('SEEDED', doc.getBlockIds().length);
process.exit(0);
