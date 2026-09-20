import type { BlockType } from '@coedit/shared';

/**
 * 块类型定义（扩展注册单元）。
 * 迭代 2 的 table / image 复用同一接口注册，BlockDoc 内核无需改动。
 */
export interface BlockDefinition {
  type: BlockType;
  label: string;
  /**
   * 块体是否承载行内富文本（Y.Text）。
   * 段落/标题/引用/代码为 true；表格、图片等结构化块为 false，
   * 自定义结构化数据放入 props 或其自有子结构。
   */
  inlineText: boolean;
  /** 代码块等：Enter 插入换行而非拆分块 */
  multiline?: boolean;
  /** 默认 props（创建时浅拷贝） */
  defaultProps?: Record<string, unknown>;
  /** 渲染提示，渲染引擎可按此选择视图实现 */
  renderTag?: string;
  placeholder?: string;
  /** 预留类型（迭代 2），内核拒绝直接创建 */
  reserved?: boolean;
  /** 容器块（如表格）持有子块 id 列表 */
  isContainer?: boolean;
}

/** 自定义块注册中心 */
export class BlockRegistry {
  private readonly defs = new Map<string, BlockDefinition>();

  register(def: BlockDefinition): void {
    if (this.defs.has(def.type)) {
      throw new Error(`block type already registered: ${def.type}`);
    }
    this.defs.set(def.type, def);
  }

  /** 允许测试 / 插件覆盖同名定义 */
  replace(def: BlockDefinition): void {
    this.defs.set(def.type, def);
  }

  get(type: string): BlockDefinition | undefined {
    return this.defs.get(type);
  }

  require(type: string): BlockDefinition {
    const def = this.defs.get(type);
    if (!def) throw new Error(`unknown block type: ${type}`);
    return def;
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  list(): BlockDefinition[] {
    return [...this.defs.values()];
  }
}

/** 内建块（段落/标题/引用/代码）+ 迭代 2 预留定义 */
export const builtinBlockDefinitions: BlockDefinition[] = [
  {
    type: 'paragraph',
    label: '正文',
    inlineText: true,
    renderTag: 'p',
    placeholder: '输入文字，或使用 / 插入块',
  },
  {
    type: 'heading',
    label: '标题',
    inlineText: true,
    renderTag: 'h1',
    defaultProps: { level: 1 },
    placeholder: '标题',
  },
  {
    type: 'quote',
    label: '引用',
    inlineText: true,
    renderTag: 'blockquote',
    placeholder: '引用内容',
  },
  {
    type: 'code',
    label: '代码块',
    inlineText: true,
    multiline: true,
    renderTag: 'pre',
    defaultProps: { language: 'plaintext' },
    placeholder: '',
  },
  // —— 迭代 2 预留：先注册元数据保证协议/schema 向前兼容 ——
  {
    type: 'table',
    label: '表格',
    inlineText: false,
    isContainer: true,
    reserved: true,
    defaultProps: { rows: 0, cols: 0 },
  },
  {
    type: 'image',
    label: '图片',
    inlineText: false,
    reserved: true,
    defaultProps: { src: '', caption: '' },
  },
];

export function createDefaultRegistry(): BlockRegistry {
  const registry = new BlockRegistry();
  for (const def of builtinBlockDefinitions) registry.register(def);
  return registry;
}
