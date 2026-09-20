<script setup lang="ts">
import { onMounted, ref } from 'vue';
import EditorView from './components/EditorView.vue';

const mounted = ref(false);
onMounted(() => { mounted.value = true; });

// 演示态：默认文档与本地用户名（真实环境由后端登录接口换取 token）
const docId = ref(new URLSearchParams(location.search).get('doc') ?? 'welcome-doc');
const userName = ref(localStorage.getItem('coedit:name') ?? `用户-${Math.floor(Math.random() * 1000)}`);
const token = ref(localStorage.getItem('coedit:token') ?? 'dev-token');
const transport = ref<'ws' | 'poll'>(
  (localStorage.getItem('coedit:transport') as 'ws' | 'poll') ?? 'ws',
);

function join(): void {
  localStorage.setItem('coedit:name', userName.value);
  localStorage.setItem('coedit:token', token.value);
  localStorage.setItem('coedit:transport', transport.value);
  location.search = `?doc=${encodeURIComponent(docId.value)}`;
}
</script>

<template>
  <div class="app-shell">
    <header v-if="!mounted || true" class="topbar">
      <div class="brand">⬡ CoEdit <span class="brand-sub">分布式块级协同编辑器</span></div>
      <div class="join-form" @submit.prevent="join">
        <input v-model="docId" class="input" placeholder="文档 ID" />
        <input v-model="userName" class="input" placeholder="昵称" />
        <select v-model="transport" class="input">
          <option value="ws">WebSocket</option>
          <option value="poll">HTTP 长轮询（降级）</option>
        </select>
        <button class="btn primary" @click="join">进入文档</button>
      </div>
    </header>

    <EditorView
      :key="docId"
      :doc-id="docId"
      :user="{ id: token + ':' + userName, name: userName }"
      :token="token"
      :preferred-transport="transport"
    />
  </div>
</template>
