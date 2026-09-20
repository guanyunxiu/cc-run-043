import assert from 'node:assert/strict';
import * as Y from 'yjs';
import test from 'node:test';
import {
  BlockDoc,
  createEmptyBlockDoc,
  LOCAL_ORIGIN,
  openLoadedBlockDoc,
  REMOTE_ORIGIN,
} from './block-doc.js';

/**
 * 模拟真实协同链路：先建立全量快照同步（SyncStep1/2 语义），再开启增量转发。
 * 新建方必须在连线前完成骨架初始化；加入方必须先吃到首个远端更新再初始化。
 */
function connectAfterSync(owner: BlockDoc, joiner: BlockDoc): () => void {
  // 加入方必须先吃到 owner 当前全量状态，随后再幂等补齐骨架
  // （此时固定键已存在，ensureInitialized 为 no-op，不会创建竞争性嵌套类型）
  Y.applyUpdate(joiner.doc, Y.encodeStateAsUpdate(owner.doc), REMOTE_ORIGIN);
  joiner.ensureInitialized();

  const offA = owner.onUpdate((u, origin) => {
    if (origin === LOCAL_ORIGIN) Y.applyUpdate(joiner.doc, u, REMOTE_ORIGIN);
  });
  const offB = joiner.onUpdate((u, origin) => {
    if (origin === LOCAL_ORIGIN) Y.applyUpdate(owner.doc, u, REMOTE_ORIGIN);
  });
  return () => {
    offA();
    offB();
  };
}

test('基础块 CRUD + 统一元数据', () => {
  const doc = createEmptyBlockDoc();
  assert.equal(doc.getBlockIds().length, 1);
  const h = doc.createBlock({ type: 'heading', props: { level: 2 } });
  assert.equal(doc.getType(h), 'heading');
  assert.equal(doc.getProps(h).get('level'), 2);
  assert.ok(doc.getMeta(h).created.at > 0);

  doc.deleteBlock(h);
  assert.equal(doc.hasBlock(h), false);
});

test('全部修改经事务驱动：origin 为 LOCAL_ORIGIN', () => {
  const doc = createEmptyBlockDoc();
  const origins: unknown[] = [];
  doc.onUpdate((_u, origin) => origins.push(origin));
  doc.createBlock({ text: 'x' });
  doc.insertText(doc.getBlockIds()[0], 0, 'hello', { bold: true });
  doc.moveBlock(doc.getBlockIds()[0], 1);
  assert.ok(origins.every((o) => o === LOCAL_ORIGIN));
});

test('块结构隔离：块内文本独立，互不影响', () => {
  const doc = createEmptyBlockDoc();
  const a = doc.getBlockIds()[0];
  const b = doc.createBlock({ text: 'bbb' });
  doc.insertText(a, 0, 'aaa');
  assert.equal(doc.getText(a).toString(), 'aaa');
  assert.equal(doc.getText(b).toString(), 'bbb');
});

test('多人实时：双向连接后状态收敛；并发新增无冲突自动合并', () => {
  const docA = createEmptyBlockDoc(new Y.Doc());
  const docB = new BlockDoc(new Y.Doc());
  const disconnect = connectAfterSync(docA, docB);

  const a1 = docA.createBlock({ text: 'from A' });
  const b1 = docB.createBlock({ text: 'from B' });

  assert.equal(docA.getBlockIds().length, docB.getBlockIds().length);
  assert.ok(docA.hasBlock(a1) && docA.hasBlock(b1));
  assert.deepEqual(new Set(docA.getBlockIds()), new Set(docB.getBlockIds()));

  // 并发移动同一块 → CRDT 收敛，不会产生重复/丢失
  docA.moveBlock(a1, 0);
  docB.moveBlock(a1, docB.getBlockIds().length - 1);
  assert.deepEqual(docA.getBlockIds(), docB.getBlockIds());
  disconnect();
});

test('撤销重做统一栈：本地编辑可回退，远端改动不被撤销', () => {
  const docA = createEmptyBlockDoc(new Y.Doc());
  const docB = new BlockDoc(new Y.Doc());
  const disconnect = connectAfterSync(docA, docB);

  const first = docA.getBlockIds()[0];
  docA.insertText(first, 0, 'ABC');
  const remoteBlock = docB.createBlock({ text: 'remote' });
  assert.equal(docA.getText(first).toString(), 'ABC');
  assert.ok(docA.hasBlock(remoteBlock));

  docA.history.undo();
  assert.equal(docA.getText(first).toString(), '');
  // 远端块依然存在：撤销只回退本地 origin 的操作
  assert.ok(docA.hasBlock(remoteBlock));

  docA.history.redo();
  assert.equal(docA.getText(first).toString(), 'ABC');
  disconnect();
});

test('拆分 / 合并块保持样式', () => {
  const doc = createEmptyBlockDoc();
  const id = doc.getBlockIds()[0];
  doc.insertText(id, 0, 'ABCD', { bold: true });
  const next = doc.splitBlockAt(id, 2);
  assert.equal(doc.getText(id).toString(), 'AB');
  assert.equal(doc.getText(next).toString(), 'CD');
  assert.equal(doc.getText(next).toDelta()[0]?.attributes?.bold, true);

  const merged = doc.mergeWithPrevious(next);
  assert.ok(merged);
  assert.equal(doc.getText(id).toString(), 'ABCD');
  assert.equal(doc.hasBlock(next), false);
});

test('全局块复制粘贴（跨文档、重新生成 id、保留样式）', () => {
  const src = createEmptyBlockDoc();
  const id = src.createBlock({ type: 'heading', text: '标题' });
  src.insertText(src.getBlockIds()[0], 0, '正文');

  const payload = src.serializeBlocks([id]);
  const dst = createEmptyBlockDoc(new Y.Doc());
  const pasted = dst.pastePayload(payload);
  assert.equal(pasted.length, 1);
  assert.notEqual(pasted[0], id); // 新身份
  assert.equal(dst.getType(pasted[0]), 'heading');
  assert.equal(dst.getText(pasted[0]).toString(), '标题');
});

test('预留块（table/image）当前版本拒绝创建，保证迭代 2 兼容演进', () => {
  const doc = createEmptyBlockDoc();
  assert.throws(() => doc.createBlock({ type: 'table' }), /reserved/);
});

test('骨架竞争压力：双方先各自初始化再合并，多种 clientID 组合下都确定性收敛', () => {
  // 最坏时序模拟：两端都在网络握手前独立 ensureInitialized
  // （首包丢包/长轮询降级等真实场景）。验证不会出现对彼此不可见的孤立嵌套类型。
  for (let seed = 0; seed < 40; seed++) {
    const d1 = new Y.Doc();
    const d2 = new Y.Doc();
    // 强制不同的初始 clientID，覆盖 CRDT 裁决的两个方向
    d1.clientID = seed + 1;
    d2.clientID = 100_000 - seed;
    const a = createEmptyBlockDoc(d1);
    const b = new BlockDoc(d2);
    b.ensureInitialized(); // b 也独立建骨架（竞争）
    // 双向合并
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1), REMOTE_ORIGIN);
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2), REMOTE_ORIGIN);
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)), REMOTE_ORIGIN);

    assert.ok(a.isInitialized, `seed=${seed}: a 未就绪`);
    assert.ok(b.isInitialized, `seed=${seed}: b 未就绪`);
    assert.deepEqual(a.getBlockIds(), b.getBlockIds(), `seed=${seed}: order 不一致`);

    // 收敛后双方都能正常编辑且互见
    const x = a.createBlock({ text: 'ax' });
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)), REMOTE_ORIGIN);
    assert.ok(b.hasBlock(x), `seed=${seed}: b 看不到 a 的块（孤立嵌套类型）`);
    assert.equal(b.getText(x).toString(), 'ax');
  }
});
