import * as Y from 'yjs';
import { h } from './dom.js';
import { TextBinding, type StructureKeyEvent } from './text-binding.js';
import type { BlockDoc } from '@coedit/block-core';

const TAG_BY_TYPE: Record<string, keyof HTMLElementTagNameMap> = {
  paragraph: 'div',
  heading: 'div',
  quote: 'div',
  code: 'div',
};

export interface BlockSurfaceOptions {
  applyEdit: (fn: () => void) => void;
  onStructureKey: (e: StructureKeyEvent) => void;
  onCaret: (blockId: string, anchor: number, head: number) => void;
}

/**
 * 单个块的渲染单元。
 * 脱离富文本框架的封装：外层 .coedit-block 承担块语义（拖拽手柄/类型/属性），
 * 内层 contenteditable 仅承载纯文本+行内样式。
 *
 * 局部更新：observeDeep 只监听本块 Y.Map，远端/本地对本块的修改只重绘本块。
 */
export class BlockSurface {
  readonly el: HTMLElement;
  readonly content: HTMLElement;
  private binding: TextBinding | null = null;
  private readonly ymap: Y.Map<any>;
  private deepObserver: (events: Y.YEvent<any>[]) => void;
  private disposed = false;

  constructor(
    readonly blockId: string,
    private readonly doc: BlockDoc,
    private readonly options: BlockSurfaceOptions,
  ) {
    this.ymap = doc._getBlockYMap(blockId);
    this.el = h('div', { className: 'coedit-block', dataset: { blockId } });
    const handle = h('div', { className: 'coedit-block-handle', draggable: 'true' }, '⋮⋮');
    handle.title = '拖拽移动 / 点击更多';
    this.content = h('div', { className: 'coedit-block-content' });
    this.el.appendChild(handle);
    this.el.appendChild(this.content);
    this.renderType();

    this.deepObserver = (events) => {
      const touchedText = events.some((e) => e.target instanceof Y.Text);
      if (!touchedText) this.renderType(); // 类型/props 变化；文本变化由 binding 自身重绘
    };
    this.ymap.observeDeep(this.deepObserver);
  }

  get textEl(): HTMLElement | null {
    return this.binding?.el ?? null;
  }

  focus(offset?: number): void {
    this.binding?.focus(offset);
  }

  /** 供远程光标定位：测量块内文本偏移的视口矩形 */
  caretRect(offset: number): DOMRect | null {
    if (!this.binding) return null;
    return measureTextOffsetRect(this.binding.el, offset);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ymap.unobserveDeep(this.deepObserver);
    this.binding?.dispose();
    this.el.remove();
  }

  private renderType(): void {
    const type = this.ymap.get('type') as string;
    const props = (this.ymap.get('props') as Y.Map<any>)?.toJSON() ?? {};
    this.el.dataset.type = type;
    this.el.classList.remove('is-heading', 'is-quote', 'is-code');
    if (type === 'heading') {
      this.el.classList.add('is-heading');
      this.el.dataset.level = String(props.level ?? 1);
    }
    if (type === 'quote') this.el.classList.add('is-quote');
    if (type === 'code') {
      this.el.classList.add('is-code');
      this.el.dataset.lang = String(props.language ?? 'plaintext');
    }

    const def = this.doc.registry.get(type);
    // 文本层复用：仅当类型标签变化时重建 TextBinding，避免编辑中重建打断输入
    const expectedTag = TAG_BY_TYPE[type] ?? 'div';
    if (!this.binding || (this.binding.el.dataset.expectedTag !== expectedTag)) {
      this.binding?.dispose();
      this.content.textContent = '';
      const ytext = this.ymap.get('text') as Y.Text | undefined;
      if (ytext) {
        this.binding = new TextBinding(
          this.blockId,
          ytext,
          expectedTag,
          def?.placeholder ?? '',
          {
            applyEdit: this.options.applyEdit,
            onCaret: this.options.onCaret,
            onStructureKey: this.options.onStructureKey,
          },
        );
        this.binding.el.dataset.expectedTag = expectedTag;
        this.content.appendChild(this.binding.el);
      }
    } else {
      this.binding.refresh(false);
    }
  }
}

export function measureTextOffsetRect(textEl: HTMLElement, offset: number): DOMRect | null {
  const sel = window.getSelection();
  const saved = sel && sel.rangeCount > 0
    ? { anchor: sel.anchorNode, ao: sel.anchorOffset, focus: sel.focusNode, fo: sel.focusOffset }
    : null;
  try {
    const range = document.createRange();
    const point = resolveTextOffset(textEl, offset);
    if (!point) return null;
    range.setStart(point.node, point.offset);
    range.setEnd(point.node, point.offset);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      // 空行回退：取元素自身矩形
      return textEl.getBoundingClientRect();
    }
    return rect;
  } catch {
    return null;
  } finally {
    if (saved && sel) {
      try {
        const r = document.createRange();
        r.setStart(saved.anchor!, saved.ao);
        r.setEnd(saved.focus!, saved.fo);
        sel.removeAllRanges();
        sel.addRange(r);
      } catch { /* noop */ }
    }
  }
}

function resolveTextOffset(root: HTMLElement, target: number): { node: Node; offset: number } | null {
  // 与 text-binding 的换算等价的轻量实现
  const walk = (node: Node, acc: { v: number }): { node: Node; offset: number } | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent ?? '').length;
      if (acc.v + len >= target) return { node, offset: target - acc.v };
      acc.v += len;
      return null;
    }
    for (const child of Array.from(node.childNodes)) {
      const hit = walk(child, acc);
      if (hit) return hit;
    }
    return null;
  };
  const acc = { v: 0 };
  return walk(root, acc) ?? null;
}
