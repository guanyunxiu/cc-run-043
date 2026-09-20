import * as Y from 'yjs';
import { h } from './dom.js';
import { BlockSurface, measureTextOffsetRect } from './block-surface.js';
import type { StructureKeyEvent } from './text-binding.js';
import type { BlockDoc } from '@coedit/block-core';
import { LOCAL_ORIGIN } from '@coedit/block-core';
import type { AwarenessPresence, CursorState, UserInfo } from '@coedit/shared';
import { withColor } from '@coedit/shared';

export interface EditorEngineOptions {
  doc: BlockDoc;
  /** 当前用户 */
  user: UserInfo;
  /** 每块估算高度（虚拟化初始测量前的回退值） */
  estimatedBlockHeight?: number;
  /** 视口外预渲染块数（上下各 N 块） */
  overscan?: number;
  onLocalCursor?: (cursor: CursorState | null) => void;
}

interface RemoteCaret {
  el: HTMLElement;
  clientId: number;
  user: UserInfo;
}

/**
 * 自研块渲染引擎：
 *  - 监听 Yjs 结构变化做局部挂载/卸载，不做整文档重绘；
 *  - 仅渲染滚动视口附近的块（虚拟化），视口外用等高占位撑开滚动条；
 *  - 远程光标 / 选区以覆盖层绘制，颜色按用户 id 稳定分配。
 *
 * 该类框架无关（纯 DOM），Vue 外壳只负责挂载与工具栏交互。
 */
export class EditorEngine {
  readonly root: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly topSpacer: HTMLElement;
  private readonly bottomSpacer: HTMLElement;
  private readonly caretLayer: HTMLElement;

  private readonly doc: BlockDoc;
  private readonly user: UserInfo;
  private readonly estimatedHeight: number;
  private readonly overscan: number;

  /** 全部块 id（Y.Array 顺序） */
  private ids: string[] = [];
  /** 已挂载块：id -> surface */
  private surfaces = new Map<string, BlockSurface>();
  /** 实测块高度缓存 */
  private heights = new Map<string, number>();
  /** 当前窗口在 ids 中的范围 */
  private windowStart = 0;
  private windowEnd = 0;

  private remoteCarets = new Map<number, RemoteCaret>();
  private resizeObserver?: ResizeObserver;
  private disposed = false;
  private rafPending = false;

  private readonly onLocalCursor?: (cursor: CursorState | null) => void;

  constructor(options: EditorEngineOptions) {
    this.doc = options.doc;
    this.user = withColor(options.user);
    this.estimatedHeight = options.estimatedBlockHeight ?? 40;
    this.overscan = options.overscan ?? 8;
    this.onLocalCursor = options.onLocalCursor;

    this.ids = this.doc.getBlockIds();

    this.root = h('div', { className: 'coedit-editor' });
    this.scroller = h('div', { className: 'coedit-scroller', onscroll: () => this.scheduleUpdate() });
    this.topSpacer = h('div', { className: 'coedit-spacer' });
    this.bottomSpacer = h('div', { className: 'coedit-spacer' });
    this.viewport = h('div', { className: 'coedit-viewport' });
    this.caretLayer = h('div', { className: 'coedit-caret-layer' });
    this.scroller.append(this.topSpacer, this.viewport, this.bottomSpacer, this.caretLayer);
    this.root.appendChild(this.scroller);

    this.bindDocument();
    this.relayout();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.scheduleUpdate());
      this.resizeObserver.observe(this.scroller);
    }
  }

  mount(container: HTMLElement): void {
    container.textContent = '';
    container.appendChild(this.root);
    // 挂载后需要一帧才能拿到滚动容器尺寸
    requestAnimationFrame(() => this.relayout());
  }

  // -------------------------------------------------------------------------
  // Yjs 结构观察 → 局部挂载
  // -------------------------------------------------------------------------

  private bindDocument(): void {
    // 块表变化（新增/删除）+ order 变化（排序）→ 重算窗口
    this.doc.observeBlocks(() => this.onStructureChanged());
  }

  private onStructureChanged(): void {
    this.ids = this.doc.getBlockIds();
    this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    if (this.rafPending || this.disposed) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.relayout();
    });
  }

  /** 重算虚拟窗口并做最小化挂载/卸载 */
  private relayout(): void {
    if (this.disposed) return;
    const scrollTop = this.scroller.scrollTop;
    const viewH = this.scroller.clientHeight || window.innerHeight;

    // 前缀高度累计，找出窗口区间
    let start = 0;
    let acc = 0;
    for (let i = 0; i < this.ids.length; i++) {
      const bh = this.heights.get(this.ids[i]) ?? this.estimatedHeight;
      if (acc + bh >= scrollTop - this.overscan * this.estimatedHeight) { start = i; break; }
      start = i + 1;
      acc += bh;
    }
    let end = this.ids.length;
    let visibleEnd = scrollTop + viewH + this.overscan * this.estimatedHeight;
    let run = 0;
    for (let i = 0; i < this.ids.length; i++) {
      run += this.heights.get(this.ids[i]) ?? this.estimatedHeight;
      if (run > visibleEnd) { end = Math.min(this.ids.length, i + 1); break; }
    }
    start = Math.max(0, start - 1);
    this.windowStart = start;
    this.windowEnd = end;

    // 卸载窗口外
    for (const [id, surface] of this.surfaces) {
      const idx = this.ids.indexOf(id);
      if (idx < start || idx >= end || idx === -1) {
        surface.dispose();
        surface.el.remove();
        this.surfaces.delete(id);
      }
    }

    // 挂载窗口内（保持顺序）
    const want = new Set(this.ids.slice(start, end));
    for (let i = start; i < end; i++) {
      const id = this.ids[i];
      if (!this.surfaces.has(id) && this.doc.hasBlock(id)) {
        const surface = this.createSurface(id);
        this.viewport.appendChild(surface.el);
        this.surfaces.set(id, surface);
        this.measureAfterPaint(id, surface);
      }
      void want;
    }
    // 排序（拖拽 / 远端移动后顺序可能变化）
    let node = this.viewport.firstElementChild;
    for (let i = start; i < end; i++) {
      const expect = this.surfaces.get(this.ids[i])?.el;
      if (!expect) continue;
      if (node !== expect && expect.parentElement === this.viewport) {
        this.viewport.insertBefore(expect, node);
      }
      node = expect?.nextElementSibling ?? node;
    }

    this.updateSpacers();
    this.renderRemoteCarets();
  }

  private createSurface(id: string): BlockSurface {
    return new BlockSurface(id, this.doc, {
      applyEdit: (fn) => this.doc.transact(fn, LOCAL_ORIGIN),
      onCaret: (blockId, anchor, head) => this.emitLocalCursor(blockId, anchor, head),
      onStructureKey: (e) => this.handleStructureKey(e),
    });
  }

  private measureAfterPaint(id: string, surface: BlockSurface): void {
    requestAnimationFrame(() => {
      const h = surface.el.offsetHeight;
      if (h > 0 && this.heights.get(id) !== h) {
        this.heights.set(id, h);
        this.updateSpacers();
      }
    });
  }

  private updateSpacers(): void {
    const heightAt = (i: number) => this.heights.get(this.ids[i]) ?? this.estimatedHeight;
    let top = 0;
    for (let i = 0; i < this.windowStart; i++) top += heightAt(i);
    let bottom = 0;
    for (let i = this.windowEnd; i < this.ids.length; i++) bottom += heightAt(i);
    this.topSpacer.style.height = `${top}px`;
    this.bottomSpacer.style.height = `${bottom}px`;
  }

  // -------------------------------------------------------------------------
  // 编辑结构键：Enter 拆分 / Backspace 合并 / 方向键跨行
  // -------------------------------------------------------------------------

  private handleStructureKey(e: StructureKeyEvent): void {
    const ids = this.ids;
    const index = ids.indexOf(e.blockId);
    if (index === -1) return;

    if (e.key === 'Enter') {
      const def = this.doc.registry.get(this.doc.getType(e.blockId) as string);
      if (def?.multiline) {
        // 代码块：插入换行
        this.doc.transact(() => {
          this.doc.getText(e.blockId).insert(e.offset, '\n');
        }, LOCAL_ORIGIN);
        this.focusBlock(e.blockId, e.offset + 1);
        return;
      }
      const newId = this.doc.splitBlockAt(e.blockId, e.offset);
      this.scheduleUpdate();
      requestAnimationFrame(() => this.focusBlock(newId, 0));
      return;
    }

    if (e.key === 'Backspace') {
      if (index === 0) return;
      const prevId = ids[index - 1];
      const merged = this.doc.mergeWithPrevious(e.blockId);
      if (merged) {
        this.scheduleUpdate();
        requestAnimationFrame(() => this.focusBlock(prevId, merged.offset));
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      if (index > 0) this.focusBlock(ids[index - 1], Number.POSITIVE_INFINITY);
      return;
    }
    if (e.key === 'ArrowDown') {
      if (index < ids.length - 1) this.focusBlock(ids[index + 1], 0);
    }
  }

  private focusBlock(id: string, offset: number): void {
    this.scrollToBlock(id);
    requestAnimationFrame(() => {
      const surface = this.surfaces.get(id);
      if (!surface) {
        // 目标块尚未挂载：强制窗口覆盖后再试一帧
        this.scheduleUpdate();
        requestAnimationFrame(() => {
          const s = this.surfaces.get(id);
          if (s) {
            const real = offset === Number.POSITIVE_INFINITY
              ? this.doc.getText(id).length
              : offset;
            s.focus(real);
          }
        });
        return;
      }
      const real = offset === Number.POSITIVE_INFINITY
        ? this.doc.getText(id).length
        : offset;
      surface.focus(real);
    });
  }

  private scrollToBlock(id: string): void {
    const idx = this.ids.indexOf(id);
    if (idx === -1) return;
    if (idx >= this.windowStart && idx < this.windowEnd) return;
    let top = 0;
    for (let i = 0; i < idx; i++) {
      top += this.heights.get(this.ids[i]) ?? this.estimatedHeight;
    }
    this.scroller.scrollTop = Math.max(0, top - this.scroller.clientHeight / 3);
    this.relayout();
  }

  private emitLocalCursor(blockId: string, anchor: number, head: number): void {
    this.onLocalCursor?.({ blockId, anchor, head });
    this.renderRemoteCarets();
  }

  // -------------------------------------------------------------------------
  // 远程光标（来自 awareness）
  // -------------------------------------------------------------------------

  /**
   * 应用一批 presence（由协同层在 awareness 更新时调用）。
   * @param entries clientId -> presence | null(null 表示离场)
   */
  setPresence(entries: Map<number, AwarenessPresence | null>): void {
    for (const [clientId, presence] of entries) {
      if (!presence) {
        this.remoteCarets.get(clientId)?.el.remove();
        this.remoteCarets.delete(clientId);
        continue;
      }
      let caret = this.remoteCarets.get(clientId);
      if (!caret) {
        const el = h('div', { className: 'coedit-remote-caret' });
        const flag = h('div', { className: 'coedit-remote-flag' });
        el.appendChild(flag);
        this.caretLayer.appendChild(el);
        caret = { el, clientId, user: presence.user };
        this.remoteCarets.set(clientId, caret);
      }
      caret.user = presence.user;
      const color = presence.user.color ?? '#888';
      caret.el.style.background = color;
      (caret.el.querySelector('.coedit-remote-flag') as HTMLElement).textContent = presence.user.name;
      (caret.el.querySelector('.coedit-remote-flag') as HTMLElement).style.background = color;
      caret.el.dataset.blockId = presence.cursor?.blockId ?? '';
      caret.el.dataset.head = String(presence.cursor?.head ?? 0);
    }
    this.renderRemoteCarets();
  }

  private renderRemoteCarets(): void {
    for (const caret of this.remoteCarets.values()) {
      const blockId = caret.el.dataset.blockId!;
      const head = Number(caret.el.dataset.head ?? 0);
      if (!blockId || !this.surfaces.has(blockId)) {
        caret.el.style.display = 'none';
        continue;
      }
      const surface = this.surfaces.get(blockId)!;
      const localRect = surface.caretRect(head);
      if (!localRect) { caret.el.style.display = 'none'; continue; }
      const scrollerRect = this.scroller.getBoundingClientRect();
      const x = localRect.left - scrollerRect.left + this.scroller.scrollLeft;
      const y = localRect.top - scrollerRect.top + this.scroller.scrollTop;
      caret.el.style.display = 'block';
      caret.el.style.transform = `translate(${x}px, ${y}px)`;
    }
  }

  // -------------------------------------------------------------------------
  // 对外编辑操作（工具栏 / 快捷键）
  // -------------------------------------------------------------------------

  /** 在当前选区块上应用行内样式 */
  formatSelection(mark: 'bold' | 'italic' | 'underline' | 'strike' | 'code', on?: boolean): void {
    const sel = this.currentBlockSelection();
    if (!sel) return;
    const { blockId, from, to } = sel;
    this.doc.transact(() => {
      const attrs: Record<string, boolean | null> = { [mark]: on === undefined ? true : on };
      this.doc.getText(blockId).format(from, Math.max(1, to - from), attrs);
    }, LOCAL_ORIGIN);
    this.focusBlock(blockId, to);
  }

  setBlockType(type: string, props?: Record<string, unknown>): void {
    const blockId = this.currentBlockId();
    if (!blockId) return;
    this.doc.setBlockType(blockId, type, props);
  }

  insertBlockAtCurrent(type: string): void {
    const blockId = this.currentBlockId();
    const idx = blockId ? this.ids.indexOf(blockId) : this.ids.length - 1;
    const newId = this.doc.createBlock({ type }, idx + 1);
    this.scheduleUpdate();
    requestAnimationFrame(() => this.focusBlock(newId, 0));
  }

  /** 全局块粘贴：返回插入块 id；非块负载返回 null 走纯文本 */
  pasteBlocks(data: DataTransfer): string[] | null {
    const idx = this.currentBlockIndex();
    return this.doc.pasteFromDataTransfer(data, idx + 1);
  }

  copySelectedBlocks(data: DataTransfer): string[] {
    const id = this.currentBlockId();
    if (!id) return [];
    const dt = this.doc.toClipboardDataTransfer([id]);
    data.setData('application/x-coedit-blocks+json', dt.getData('application/x-coedit-blocks+json'));
    data.setData('text/plain', dt.getData('text/plain'));
    return [id];
  }

  get currentUser(): UserInfo {
    return this.user;
  }

  private currentBlockId(): string | null {
    const node = document.activeElement;
    const block = (node as HTMLElement | null)?.closest?.('.coedit-block');
    return (block as HTMLElement | null)?.dataset.blockId ?? null;
  }

  private currentBlockIndex(): number {
    const id = this.currentBlockId();
    return id ? this.ids.indexOf(id) : this.ids.length - 1;
  }

  private currentBlockSelection(): { blockId: string; from: number; to: number } | null {
    const blockId = this.currentBlockId();
    if (!blockId) return null;
    const surface = this.surfaces.get(blockId);
    const off = surface?.textEl ? (this.readDomOffset(surface.textEl)) : 0;
    return { blockId, from: off, to: off };
  }

  private readDomOffset(textEl: HTMLElement): number {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !textEl.contains(sel.focusNode)) return 0;
    return domPointToOffset(textEl, sel.focusNode, sel.focusOffset);
  }

  dispose(): void {
    this.disposed = true;
    this.resizeObserver?.disconnect();
    for (const s of this.surfaces.values()) s.dispose();
    this.surfaces.clear();
    for (const c of this.remoteCarets.values()) c.el.remove();
    this.remoteCarets.clear();
    this.root.remove();
  }
}

function domPointToOffset(root: HTMLElement, node: Node | null, offset: number): number {
  if (!node) return 0;
  let total = 0;
  let cur: Node | null = node;
  while (cur && cur !== root) {
    const parent: Node | null = cur.parentNode;
    if (!parent) break;
    const idx = Array.prototype.indexOf.call(parent.childNodes, cur);
    for (let i = 0; i < idx; i++) {
      const child = parent.childNodes[i];
      total += child.nodeType === Node.TEXT_NODE ? (child.textContent ?? '').length : 1;
    }
    cur = parent;
  }
  if (node.nodeType === Node.TEXT_NODE) total += offset;
  return total;
}

// measureTextOffsetRect 重新导出，便于外部（Vue 层）做悬浮工具栏定位
export { measureTextOffsetRect };
