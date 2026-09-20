/**
 * DOM 构造小工具：渲染引擎内部使用显式 createElement，
 * 刻意脱离传统富文本框架（contenteditable 只挂在文本层）。
 */

export type HAttrs = {
  className?: string;
  dataset?: Record<string, string>;
  draggable?: boolean | 'true' | 'false';
  title?: string;
  contentEditable?: string;
  spellcheck?: boolean;
} & {
  [key: `on${string}`]: EventListener | undefined;
} & Record<string, string | number | boolean | null | undefined | EventListener | Record<string, string>>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: HAttrs = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') el.className = String(v);
    else if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v as Record<string, string>)) {
        el.dataset[dk] = dv;
      }
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/**
 * 将 Y.Text delta 渲染为内联 DOM（粗体/斜体/下划线/删除线/行内码/链接/颜色）。
 * 纯重建 —— 只在单个块的文本层调用，块外结构不受影响。
 */
import type { InlineAttributes } from '@coedit/shared';

export type DeltaOp = { insert: string; attributes?: InlineAttributes };

export function renderInline(container: HTMLElement, delta: DeltaOp[]): void {
  container.textContent = '';
  for (const op of delta) {
    if (typeof op.insert !== 'string') continue; // 不支持 embed（迭代 2）
    const parts = op.insert.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) container.appendChild(document.createElement('br'));
      if (!part) return;
      container.appendChild(applyInlineAttrs(document.createTextNode(part), op.attributes));
    });
  }
}

function applyInlineAttrs(node: Text, attrs?: InlineAttributes): Node {
  if (!attrs) return node;
  let el: Node = node;
  if (attrs.link) {
    const a = document.createElement('a');
    a.href = attrs.link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.appendChild(node);
    el = a;
  }
  const wrap: Array<[boolean, string]> = [
    [!!attrs.bold, 'strong'],
    [!!attrs.italic, 'em'],
    [!!attrs.underline, 'u'],
    [!!attrs.strike, 's'],
    [!!attrs.code, 'code'],
  ];
  for (const [on, tag] of wrap) {
    if (!on) continue;
    const w = document.createElement(tag);
    w.appendChild(el);
    el = w;
  }
  const host = el instanceof HTMLElement ? el : el.parentElement;
  if (host) {
    if (attrs.color) host.style.color = attrs.color;
    if (attrs.background) host.style.background = attrs.background;
  }
  return el;
}
