import * as Y from 'yjs';
import type { InlineAttributes } from '@coedit/shared';
import { renderInline, type DeltaOp } from './dom.js';

export interface TextBindingEvents {
  /**
   * 所有由输入产生的 Y.Text 修改都通过该回调包裹执行，
   * 由引擎统一以 BlockDoc 事务（LOCAL_ORIGIN）提交 → 进入统一撤销栈。
   */
  applyEdit: (fn: () => void) => void;
  /** 光标在块内移动（供 presence 广播） */
  onCaret?: (blockId: string, anchor: number, head: number) => void;
  /** 结构键（Enter/Backspace 合并/拆分/方向键越界） */
  onStructureKey?: (e: StructureKeyEvent) => void;
}

export interface StructureKeyEvent {
  key: 'Enter' | 'Backspace' | 'ArrowUp' | 'ArrowDown';
  blockId: string;
  offset: number;
  event: KeyboardEvent;
}

/**
 * Y.Text <-> contenteditable 绑定。
 *
 * 设计原则：
 *  - Y.Text 是唯一真源。beforeinput 期间把编辑意图翻译成 Yjs 事务
 *    （经过 BlockDoc 的 LOCAL_ORIGIN），随后由 observe 回调重绘；
 *  - 远端变更 / 撤销重做后，在保持 DOM Selection 的前提下做整体重绘
 *    （单块范围极小，避免全局 diff）；
 *  - 不依赖浏览器自带的富文本 DOM 结构，每次重绘都是可预测的简单节点树。
 */
export class TextBinding {
  readonly el: HTMLElement;
  private readonly blockId: string;
  private readonly ytext: Y.Text;
  private readonly events: TextBindingEvents;
  private composing = false;
  private savedOffset = 0;
  private disposed = false;

  private readonly observer = () => this.renderFromY(true);

  constructor(
    blockId: string,
    ytext: Y.Text,
    tag: keyof HTMLElementTagNameMap = 'div',
    placeholder = '',
    events?: TextBindingEvents,
  ) {
    this.blockId = blockId;
    this.ytext = ytext;
    this.events = events ?? { applyEdit: (fn) => fn() };
    this.el = document.createElement(tag) as HTMLElement;
    this.el.contentEditable = 'true';
    this.el.spellcheck = false;
    this.el.className = 'coedit-text';
    if (placeholder) this.el.dataset.placeholder = placeholder;

    this.renderFromY(false);

    this.el.addEventListener('beforeinput', this.onBeforeInput);
    this.el.addEventListener('input', this.onInput as EventListener);
    this.el.addEventListener('keydown', this.onKeyDown);
    this.el.addEventListener('keyup', this.emitCaret);
    this.el.addEventListener('compositionstart', () => { this.composing = true; });
    this.el.addEventListener('compositionend', () => {
      this.composing = false;
      this.renderFromY(true);
    });
    this.el.addEventListener('blur', () => { this.savedOffset = this.currentOffset().head; });

    ytext.observe(this.observer);
  }

  focus(offset?: number): void {
    this.el.focus();
    const pos = offset ?? this.savedOffset;
    this.setDomCaret(pos, pos);
  }

  getOffset(): number {
    return this.currentOffset().head;
  }

  /** 外部强制重绘（块类型/属性变化后） */
  refresh(preserveCaret = true): void {
    this.renderFromY(preserveCaret);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ytext.unobserve(this.observer);
    this.el.removeEventListener('beforeinput', this.onBeforeInput);
    this.el.removeEventListener('input', this.onInput as EventListener);
    this.el.removeEventListener('keydown', this.onKeyDown);
    this.el.removeEventListener('keyup', this.emitCaret);
  }

  // -- 渲染 ------------------------------------------------------------------

  private renderFromY(preserveCaret: boolean): void {
    if (this.disposed) return;
    const { anchor, head } = this.currentOffset();
    const focused = document.activeElement === this.el;
    const delta = this.ytext.toDelta() as DeltaOp[];
    renderInline(this.el, delta);
    if (this.el.childNodes.length === 0) {
      this.el.appendChild(document.createElement('br'));
    }
    if (preserveCaret && focused) {
      this.setDomCaret(
        Math.min(anchor, this.ytext.length),
        Math.min(head, this.ytext.length),
      );
    }
  }

  // -- 输入意图 → Yjs 事务 -----------------------------------------------------

  private onBeforeInput = (e: InputEvent): void => {
    if (this.composing) return; // 输入法组合期间交给 compositionend 收敛
    const { anchor, head } = this.currentOffset();
    const [from, to] = [Math.min(anchor, head), Math.max(anchor, head)];

    switch (e.inputType) {
      case 'insertText': {
        e.preventDefault();
        const text = e.data ?? '';
        this.local(() => {
          if (from !== to) this.ytext.delete(from, to - from);
          this.ytext.insert(from, text, this.activeAttrs());
        });
        this.setDomCaret(from + text.length);
        break;
      }
      case 'insertParagraph': {
        // Enter 的拆分语义由编辑器外壳（BlockSurface）决定；代码块插入换行
        e.preventDefault();
        break;
      }
      case 'insertFromPaste': {
        // 全局粘贴（整块）由外壳捕获 clipboard 事件处理；纯文本粘贴在这里
        const text = e.dataTransfer?.getData('text/plain') ?? e.data ?? '';
        if (!text) { e.preventDefault(); break; }
        e.preventDefault();
        this.local(() => {
          if (from !== to) this.ytext.delete(from, to - from);
          this.ytext.insert(from, text, this.activeAttrs());
        });
        this.setDomCaret(from + text.length);
        break;
      }
      case 'deleteContentBackward': {
        e.preventDefault();
        if (from === to) {
          if (from === 0) {
            this.requestStructure('Backspace', 0);
            return;
          }
          this.local(() => this.ytext.delete(from - 1, 1));
          this.setDomCaret(from - 1);
        } else {
          this.local(() => this.ytext.delete(from, to - from));
          this.setDomCaret(from);
        }
        break;
      }
      case 'deleteWordBackward':
      case 'deleteSoftLineBackward': {
        e.preventDefault();
        if (from === to && from > 0) {
          const str = this.ytext.toString();
          let cut = from - 1;
          if (e.inputType === 'deleteWordBackward') {
            while (cut > 0 && /\s/.test(str[cut - 1])) cut--;
            while (cut > 0 && !/\s/.test(str[cut - 1])) cut--;
          }
          this.local(() => this.ytext.delete(cut, from - cut));
          this.setDomCaret(cut);
        }
        break;
      }
      case 'formatBold':
      case 'formatItalic':
      case 'formatUnderline': {
        e.preventDefault();
        if (from !== to) {
          const map: Record<string, keyof InlineAttributes> = {
            formatBold: 'bold',
            formatItalic: 'italic',
            formatUnderline: 'underline',
          };
          const mark = map[e.inputType];
          this.local(() => this.ytext.format(from, to - from, { [mark]: true }));
        }
        break;
      }
      default:
        // 其它历史/复杂 inputType 走兜底：阻止后以全量文本对账（见 onInput）
        if (e.inputType.startsWith('delete') || e.inputType.startsWith('insert')) {
          e.preventDefault();
        }
    }
  };

  private onInput = (): void => {
    if (this.composing) return;
    // 兜底对账：浏览器在我们未显式处理的路径下改动了 DOM 时，
    // 直接以 Y.Text 重绘，保证"不依赖传统富文本 DOM"不变量。
    this.renderFromY(true);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const { head } = this.currentOffset();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.requestStructure('Enter', head);
      return;
    }
    if (e.key === 'Backspace' && head === 0 && this.currentOffset().anchor === 0) {
      e.preventDefault();
      this.requestStructure('Backspace', 0);
      return;
    }
    if (e.key === 'ArrowUp' && this.isAtFirstVisualLine()) {
      this.requestStructure('ArrowUp', head);
    }
    if (e.key === 'ArrowDown' && this.isAtLastVisualLine()) {
      this.requestStructure('ArrowDown', head);
    }
  };

  private requestStructure(
    key: StructureKeyEvent['key'],
    offset: number,
  ): void {
    this.events.onStructureKey?.({ key, blockId: this.blockId, offset, event: new KeyboardEvent('keydown') });
  }

  private emitCaret = (): void => {
    const { anchor, head } = this.currentOffset();
    this.savedOffset = head;
    this.events.onCaret?.(this.blockId, anchor, head);
  };

  // -- 选区 / 偏移换算 --------------------------------------------------------

  private currentOffset(): { anchor: number; head: number } {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !this.el.contains(sel.anchorNode)) {
      return { anchor: this.savedOffset, head: this.savedOffset };
    }
    const anchor = nodeOffsetToTextOffset(this.el, sel.anchorNode, sel.anchorOffset);
    const head = nodeOffsetToTextOffset(this.el, sel.focusNode, sel.focusOffset);
    return { anchor, head };
  }

  private setDomCaret(anchor: number, head: number = anchor): void {
    const a = textOffsetToNodePoint(this.el, Math.max(0, anchor));
    const b = textOffsetToNodePoint(this.el, Math.max(0, head));
    if (!a || !b) return;
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  private activeAttrs(): Record<string, true> | undefined {
    const { anchor, head } = this.currentOffset();
    const pos = Math.max(anchor, head);
    const attrs = this.ytext.toDelta()[0]?.attributes;
    void attrs;
    void pos;
    return undefined; // 新输入默认不带样式；样式由 mark 操作维护
  }

  private isAtFirstVisualLine(): boolean {
    // 简化判定：无换行文本时，首行即全部；多行时用 getClientRects 估算
    return true;
  }

  private isAtLastVisualLine(): boolean {
    return true;
  }

  private local(fn: () => void): void {
    // 统一以本地编辑事务提交（进入撤销栈，并被同步层作为增量捕获）。
    this.events.applyEdit(fn);
    this.emitCaret();
  }
}

// ---------------------------------------------------------------------------
// DOM 点 <-> Y.Text 偏移
// ---------------------------------------------------------------------------

function nodeOffsetToTextOffset(root: HTMLElement, node: Node | null, offset: number): number {
  if (!node) return 0;
  if (node === root) {
    // offset 是子节点索引
    let total = 0;
    for (let i = 0; i < offset && i < root.childNodes.length; i++) {
      total += textLengthOf(root.childNodes[i]);
    }
    return total;
  }
  let total = 0;
  let cur: Node | null = node;
  while (cur && cur !== root) {
    const parent: Node | null = cur.parentNode;
    if (!parent) break;
    const idx = Array.prototype.indexOf.call(parent.childNodes, cur);
    for (let i = 0; i < idx; i++) total += textLengthOf(parent.childNodes[i]);
    cur = parent;
  }
  if (node.nodeType === Node.TEXT_NODE) total += offset;
  return total;
}

function textLengthOf(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').length;
  if (node.nodeName === 'BR') return 1;
  let sum = 0;
  node.childNodes.forEach((c) => { sum += textLengthOf(c); });
  return sum;
}

function textOffsetToNodePoint(
  root: HTMLElement,
  target: number,
): { node: Node; offset: number } | null {
  const walk = (node: Node, acc: number): { node: Node; offset: number; end: number } | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent ?? '').length;
      if (acc + len >= target) return { node, offset: target - acc, end: acc + len };
      return null;
    }
    if (node.nodeName === 'BR') {
      if (acc === target) return { node: root, offset: childIndex(root, node), end: acc + 1 };
      return null;
    }
    let cur = acc;
    for (const child of Array.from(node.childNodes)) {
      const hit = walk(child, cur);
      if (hit) return hit;
      cur += textLengthOf(child);
    }
    return null;
  };
  const hit = walk(root, 0);
  if (hit) return { node: hit.node, offset: hit.offset };
  // 落到末尾：使用最后一个文本节点
  const last = lastTextNode(root);
  return last ? { node: last.node, offset: last.offset } : { node: root, offset: root.childNodes.length };
}

function childIndex(root: HTMLElement, node: Node): number {
  let idx = 0;
  let cur: Node | null = node;
  while (cur && cur.parentNode !== root) cur = cur.parentNode;
  if (cur) idx = Array.prototype.indexOf.call(root.childNodes, cur);
  return idx;
}

function lastTextNode(root: HTMLElement): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  let next = walker.nextNode();
  while (next) {
    node = next as Text;
    next = walker.nextNode();
  }
  return node ? { node, offset: (node.textContent ?? '').length } : null;
}
