import * as Y from 'yjs';
import type { ClipboardBlock, ClipboardPayload } from '@coedit/shared';
import { createBlockId } from '@coedit/shared';
import type { BlockDoc } from './block-doc.js';
import { LOCAL_ORIGIN } from './block-doc.js';

/** 全局块剪贴板 MIME（跨文档 / 跨标签页，payload 自描述） */
export const CLIPBOARD_MIME = 'application/x-coedit-blocks+json';

/**
 * 序列化给定块（按文档 order 中出现的先后排序），携带：
 *  - 完整块元数据（type/props/created）
 *  - Y.Text 的 delta（保留行内样式）
 */
export function serializeBlocks(
  doc: BlockDoc,
  ids: string[],
  sourceDocId: string,
): ClipboardPayload {
  const idSet = new Set(ids);
  const orderedIds = doc.getBlockIds().filter((id) => idSet.has(id));

  const blocks: ClipboardBlock[] = orderedIds.map((id) => {
    const meta = doc.getMeta(id);
    let delta: ClipboardBlock['delta'] = [];
    const def = doc.registry.get(meta.type as string);
    if (def?.inlineText) {
      delta = doc.getText(id).toDelta() as ClipboardBlock['delta'];
    }
    return { meta, delta };
  });

  return { v: 1, sourceDocId, blocks };
}

/**
 * 反序列化并插入：
 *  - 粘贴时重新生成块 id（保留 created 原始信息），避免跨文档身份冲突；
 *  - 整块插入在同一 Yjs 事务内完成 → 撤销一次即可整段回退；
 *  - 并发粘贴由 CRDT 自动收敛，无需锁。
 */
export function deserializeBlocks(
  doc: BlockDoc,
  payload: ClipboardPayload,
  atIndex?: number,
): string[] {
  if (payload.v !== 1) throw new Error(`unsupported clipboard schema: ${payload.v}`);
  const newIds: string[] = [];

  doc.transact(() => {
    let cursor = atIndex === undefined ? doc.getBlockIds().length : atIndex;
    for (const block of payload.blocks) {
      const def = doc.registry.get(block.meta.type as string);
      // 未知 / 预留块降级为段落，保证向前兼容（旧客户端粘贴新块不丢内容）
      const type = !def || def.reserved ? 'paragraph' : block.meta.type;
      const id = createBlockId();
      doc.createBlock(
        {
          id,
          type,
          props: block.meta.props,
          text: '',
        },
        cursor,
      );
      cursor += 1;

      if (def?.inlineText && block.delta.length) {
        const text = doc.getText(id);
        for (const op of block.delta) {
          text.insert(text.length, op.insert, op.attributes);
        }
      }
      newIds.push(id);
    }
  }, LOCAL_ORIGIN);

  return newIds;
}
