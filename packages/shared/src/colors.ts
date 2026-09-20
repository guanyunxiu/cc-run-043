import type { UserInfo } from './types.js';

/**
 * 多人光标唯一标识色调色板（HSL 等距取色，视觉上可区分）。
 * 同一个 userId 在任意客户端、任意会话中都稳定映射到同一颜色。
 */
const PALETTE: readonly string[] = [
  '#f43f5e', // rose
  '#f97316', // orange
  '#eab308', // yellow
  '#84cc16', // lime
  '#22c55e', // green
  '#10b981', // emerald
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#6366f1', // indigo
  '#a855f7', // purple
  '#ec4899', // pink
];

/** 稳定字符串哈希（FNV-1a 32bit） */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function colorForUser(userId: string): string {
  return PALETTE[hash32(userId) % PALETTE.length];
}

export function withColor(user: UserInfo): UserInfo {
  return user.color ? user : { ...user, color: colorForUser(user.id) };
}
