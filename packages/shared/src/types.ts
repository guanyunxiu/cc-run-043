/**
 * 全局公共类型定义：块模型 / 用户 / 光标选区 / 同步与权限。
 */

// ---------------------------------------------------------------------------
// 块文档模型
// ---------------------------------------------------------------------------

/** 内建块类型。自定义块通过 BlockRegistry 注册扩展。 */
export type BuiltinBlockType =
  | 'paragraph'
  | 'heading'
  | 'code'
  | 'quote'
  /** 迭代 2 预留 */
  | 'table'
  | 'image';

/** 块类型字符串：内建 + 任意自定义扩展（custom:xxx） */
export type BlockType = BuiltinBlockType | (string & {});

/** 标题层级 */
export type HeadingLevel = 1 | 2 | 3;

/**
 * 统一块元数据。
 * - id: 全局唯一（建议 createBlockId() 生成）
 * - type: 块类型
 * - created: 创建信息（离线时也可生成，clientId 为 Yjs clientID）
 * - props: 自定义属性（块类型参数，如 heading.level / code.language）
 */
export interface BlockMeta {
  id: string;
  type: BlockType;
  created: {
    at: number;
    by: string; // userId；匿名离线时为本地 clientId
  };
  props: Record<string, unknown>;
}

/** 行内样式标记（作用在 Y.Text 上的 delta attributes） */
export interface InlineAttributes {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string | null;
  /** 行内颜色/背景色等扩展样式 */
  color?: string;
  background?: string;
}

/** 剪贴板中序列化的块（全局块复制粘贴） */
export interface ClipboardBlock {
  meta: BlockMeta;
  /** Y.Text delta：[{insert, attributes?}] */
  delta: Array<{ insert: string; attributes?: InlineAttributes }>;
}

export interface ClipboardPayload {
  /** 固定 schema 版本，向前兼容用 */
  v: 1;
  sourceDocId: string;
  blocks: ClipboardBlock[];
}

// ---------------------------------------------------------------------------
// 用户 / 感知（光标、选区）
// ---------------------------------------------------------------------------

export interface UserInfo {
  id: string;
  name: string;
  /** 不填则由系统按 id 分配唯一标识色 */
  color?: string;
}

/** 用户当前光标 / 选区（块内以 Y.Text 索引表示） */
export interface CursorState {
  blockId: string;
  /** 锚点偏移 */
  anchor: number;
  /** 焦点偏移（与 anchor 不同即构成选区） */
  head: number;
}

/** 通过广播协议同步的 presence 内容 */
export interface AwarenessPresence {
  user: UserInfo;
  cursor: CursorState | null;
  /** 最近一次更新时间戳 */
  t: number;
}

// ---------------------------------------------------------------------------
// 同步队列（IndexedDB 中暂存的待同步二进制增量）
// ---------------------------------------------------------------------------

export type PendingUpdateReason = 'offline-edit' | 'retry';

export interface PendingUpdateRecord {
  /** 自增主键（IndexedDB keyPath） */
  id?: number;
  docId: string;
  /** Yjs 二进制增量 update */
  update: Uint8Array;
  stateVector?: Uint8Array | null;
  reason: PendingUpdateReason;
  createdAt: number;
  retryCount: number;
}

/** 临时文档状态（本地 UI 草稿态等，不进入协同） */
export interface TempDocState {
  docId: string;
  scrollTop?: number;
  activeBlockId?: string | null;
  updatedAt: number;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 连接 / 权限
// ---------------------------------------------------------------------------

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'reconnecting'
  | 'error';

export type DocPermission = 'read' | 'write' | 'owner';

export interface DocMeta {
  id: string;
  title: string;
  ownerId: string;
  updatedAt: number;
  createdAt: number;
}

export interface AuthResult {
  user: UserInfo;
  permission: DocPermission;
}
