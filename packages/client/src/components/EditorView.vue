<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type { AwarenessPresence, ConnectionStatus, UserInfo } from '@coedit/shared';
import { DocumentSession } from '../sync/session.js';
import type { SyncState } from '../sync/sync-manager.js';

const props = defineProps<{
  docId: string;
  user: UserInfo;
  token: string;
  preferredTransport: 'ws' | 'poll';
}>();

const containerEl = ref<HTMLElement | null>(null);
const session = shallowRef<DocumentSession | null>(null);
const state = ref<SyncState | null>(null);
const showSlash = ref(false);
const slashX = ref(0);
const slashY = ref(0);

let slashListener: ((e: KeyboardEvent) => void) | null = null;
let keyListener: ((e: KeyboardEvent) => void) | null = null;

const statusMeta: Record<ConnectionStatus, { text: string; cls: string }> = {
  idle: { text: '未连接', cls: 'st-idle' },
  connecting: { text: '连接中…', cls: 'st-wait' },
  online: { text: '已在线', cls: 'st-online' },
  offline: { text: '离线（编辑将自动暂存）', cls: 'st-offline' },
  reconnecting: { text: '重连中…', cls: 'st-wait' },
  error: { text: '连接错误', cls: 'st-error' },
};

const blockPalette = [
  { type: 'paragraph', label: '正文', desc: '普通段落文本' },
  { type: 'heading', label: '标题 1', desc: '一级标题', props: { level: 1 } },
  { type: 'heading', label: '标题 2', desc: '二级标题', props: { level: 2 } },
  { type: 'heading', label: '标题 3', desc: '三级标题', props: { level: 3 } },
  { type: 'quote', label: '引用', desc: '引用块' },
  { type: 'code', label: '代码块', desc: '等宽多行代码' },
];

onMounted(async () => {
  const s = await DocumentSession.create({
    docId: props.docId,
    token: props.token,
    user: props.user,
    wsUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/coedit`,
    httpUrl: `/api/rooms`,
    preferredTransport: props.preferredTransport,
  });
  session.value = s;
  s.mount(containerEl.value!);
  s.sync.onState((next) => {
    state.value = next;
    // 把远程 presence 同步给渲染引擎光标层
    const map = new Map<number, AwarenessPresence | null>();
    for (const p of next.peers) map.set(p.clientId, p.presence);
    s.engine.setPresence(map);
  });
  await s.startSync();

  // 全局快捷键：撤销/重做（在线离线统一栈）
  keyListener = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) s.doc.history.redo();
      else s.doc.history.undo();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      s.doc.history.redo();
    }
  };
  window.addEventListener('keydown', keyListener);

  // "/" 唤起块菜单（基于当前光标块位置）
  slashListener = (e: KeyboardEvent) => {
    if (e.key === '/') {
      const r = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
      if (r) {
        slashX.value = r.left;
        slashY.value = r.bottom + 4;
        showSlash.value = true;
      }
    }
    if (e.key === 'Escape') showSlash.value = false;
  };
  window.addEventListener('keydown', slashListener);

  // 周期保存临时文档状态
  window.addEventListener('beforeunload', () => void s.saveTempState());
});

function insertBlock(type: string, blockProps?: Record<string, unknown>): void {
  const s = session.value;
  if (!s) return;
  if (type === 'heading') s.engine.setBlockType('heading', blockProps);
  else s.engine.setBlockType(type);
  showSlash.value = false;
}

function toggleMark(mark: 'bold' | 'italic' | 'underline' | 'strike' | 'code'): void {
  session.value?.engine.formatSelection(mark);
}

onBeforeUnmount(async () => {
  if (slashListener) window.removeEventListener('keydown', slashListener);
  if (keyListener) window.removeEventListener('keydown', keyListener);
  await session.value?.saveTempState();
  await session.value?.destroy();
});
</script>

<template>
  <main class="workspace">
    <div class="toolbar">
      <button class="btn" @click="session?.doc.history.undo()" title="撤销 (⌘Z)">↶</button>
      <button class="btn" @click="session?.doc.history.redo()" title="重做 (⌘⇧Z)">↷</button>
      <span class="divider" />
      <button class="btn" @click="toggleMark('bold')" title="粗体"><b>B</b></button>
      <button class="btn" @click="toggleMark('italic')" title="斜体"><i>I</i></button>
      <button class="btn" @click="toggleMark('underline')" title="下划线"><u>U</u></button>
      <button class="btn" @click="toggleMark('strike')" title="删除线"><s>S</s></button>
      <button class="btn mono" @click="toggleMark('code')" title="行内代码">&lt;/&gt;</button>
      <span class="divider" />
      <button class="btn" v-for="(p, i) in blockPalette.slice(0, 4)" :key="i"
        @click="insertBlock(p.type, p.props)">{{ p.label }}</button>
      <span class="spacer" />
      <div v-if="state" class="peers">
        <span v-for="p in state.peers" :key="p.clientId" class="peer"
          :style="{ background: p.presence?.user.color ?? '#888' }"
          :title="p.presence?.user.name">
          {{ (p.presence?.user.name ?? '?').slice(0, 1) }}
        </span>
      </div>
      <span class="status" :class="statusMeta[state?.status ?? 'idle'].cls">
        <i class="dot" />
        {{ statusMeta[state?.status ?? 'idle'].text }}
        <em v-if="state?.pendingCount">· 待同步 {{ state.pendingCount }}</em>
        <em class="transport">· {{ state?.transport === 'poll' ? '长轮询' : state?.transport === 'ws' ? 'WebSocket' : '—' }}</em>
      </span>
    </div>

    <div ref="containerEl" class="editor-host" />

    <div v-if="showSlash" class="slash-menu" :style="{ left: slashX + 'px', top: slashY + 'px' }">
      <div class="slash-title">插入块</div>
      <button v-for="(p, i) in blockPalette" :key="i" class="slash-item"
        @click="insertBlock(p.type, p.props)">
        <span class="slash-label">{{ p.label }}</span>
        <span class="slash-desc">{{ p.desc }}</span>
      </button>
    </div>
  </main>
</template>
