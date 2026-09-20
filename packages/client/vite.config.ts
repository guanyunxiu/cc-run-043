import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // 开发期把 API / 协同端口代理到 NestJS，避免跨域与手工切换地址
      '/api': { target: 'http://localhost:3000', changeOrigin: true, ws: true },
      '/coedit': { target: 'http://localhost:3000', changeOrigin: true, ws: true },
    },
  },
});
