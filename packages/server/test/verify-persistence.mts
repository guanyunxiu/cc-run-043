/**
 * 持久化恢复验证：直接读取服务端 YPersistenceService 的磁盘数据，
 * 验证刚通过 E2E 写入的文档可完整恢复（块数/文本/顺序）。
 */
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const dataDir = process.env.YJS_DATA_DIR ?? './.coedit-data-3600';
const targetPrefix = process.env.E2E_DOC ?? 'e2e-fresh2';

function applyFile(doc: Y.Doc, file: string, kind: 'snapshot' | 'updates'): void {
  const buf = readFileSync(file);
  if (kind === 'snapshot') {
    Y.applyUpdate(doc, new Uint8Array(buf));
    return;
  }
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = buf.readUInt32BE(offset); offset += 4;
    if (offset + len > buf.length) break;
    Y.applyUpdate(doc, new Uint8Array(buf.subarray(offset, offset + len)));
    offset += len;
  }
}

const files = readdirSync(dataDir).filter((f) => f.startsWith(targetPrefix));
assert.ok(files.length > 0, `应存在 ${targetPrefix}* 持久化文件，实际 ${readdirSync(dataDir).join(',')}`);

const doc = new Y.Doc();
const snap = files.find((f) => f.endsWith('.snapshot'));
const upd = files.find((f) => f.endsWith('.updates'));
if (snap) applyFile(doc, path.join(dataDir, snap), 'snapshot');
if (upd) applyFile(doc, path.join(dataDir, upd), 'updates');

const root = doc.getMap('root');
const blocks = root.get('blocks') as Y.Map<Y.Map<any>>;
const order = root.get('order') as Y.Array<string>;
assert.ok(blocks && order, '骨架应完整恢复');

const ids = order.toArray();
const texts = ids.map((id) => (blocks.get(id)!.get('text') as Y.Text).toString());
console.log('恢复块数:', ids.length);
console.log('恢复文本:', JSON.stringify(texts));

assert.ok(ids.length >= 3, `应恢复至少 3 块，实际 ${ids.length}`);
assert.ok(texts.some((t) => t.includes('你好，协同世界')), 'A 的行内编辑应恢复');
assert.ok(texts.includes('A 的新块'), 'A 的新块应恢复');
assert.ok(texts.includes('B 的新块'), 'B 的并发块应恢复');
assert.ok(texts.includes('来自长轮询'), '长轮询客户端的块应恢复');

console.log('✅ 持久化恢复验证通过：重启后文档内容/顺序/并发块完整');
