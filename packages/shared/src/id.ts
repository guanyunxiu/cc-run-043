/**
 * 块 ID 生成：优先使用 UUID v4；非安全上下文（旧浏览器 / 测试）下降级。
 * 离线生成无冲突：UUID 空间足够大，CRDT 侧即使碰撞也由 Yjs 合并语义兜底。
 */
export function createBlockId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h
      .slice(6, 8)
      .join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
  }
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
