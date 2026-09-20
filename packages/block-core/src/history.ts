import * as Y from 'yjs';
import { LOCAL_ORIGIN } from './block-doc.js';

export interface HistoryStackState {
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * 统一撤销 / 重做栈（在线、离线完全一致）。
 *
 * 底层是 Y.UndoManager：
 *  - trackedOrigins 只包含 LOCAL_ORIGIN → 本地编辑入栈；
 *  - 远端合并（REMOTE_ORIGIN）、IndexedDB 重放（origin=null）不入栈，
 *    因此撤销不会回退掉别人的改动；
 *  - Yjs 的 UndoManager 是 CRDT 感知的：在并发修改存在时仍能正确地
 *    "只撤销自己的那部分操作"，实现状态统一回退；
 *  - 追踪根 Map 即可覆盖块新增/删除/移动、props 修改及块内 Y.Text 编辑。
 */
export class HistoryManager {
  private readonly manager: Y.UndoManager;
  private readonly listeners = new Set<(s: HistoryStackState) => void>();

  constructor(
    root: Y.AbstractType<any> | Y.AbstractType<any>[],
    private readonly captureTimeout = 500,
  ) {
    this.manager = new Y.UndoManager(root as never, {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout,
    });
    const emit = () => this.emit();
    this.manager.on('stack-item-added', emit);
    this.manager.on('stack-item-popped', emit);
    this.manager.on('stack-item-updated', emit);
  }

  undo(): void {
    this.manager.undo();
  }

  redo(): void {
    this.manager.redo();
  }

  get canUndo(): boolean {
    return this.manager.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.manager.redoStack.length > 0;
  }

  /**
   * 停止当前合并窗口：使后续编辑成为新的撤销单元。
   * 例如失焦后再输入，撤销不应跨越两次编辑会话。
   */
  stopCapture(): void {
    this.manager.stopCapturing();
  }

  onChange(cb: (s: HistoryStackState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    const s = { canUndo: this.canUndo, canRedo: this.canRedo };
    for (const cb of this.listeners) cb(s);
  }

  destroy(): void {
    this.manager.destroy();
    this.listeners.clear();
  }
}
