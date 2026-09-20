# @coedit/server

NestJS 协同后端。完整系统说明见仓库根目录 `README.md`。

## 运行

```bash
npm run build
# PG/Redis 可选；缺失时自动降级为单机内存模式
node dist/main.js
# 或开发模式（tsx watch）
npm run start:dev
```

- HTTP REST + HTTP 长轮询：`http://localhost:3000/api/...`
- 协同 WebSocket：`ws://localhost:3000/coedit`
- Yjs 二进制持久化目录：`YJS_DATA_DIR`（默认 `./.coedit-data`）

## 端到端测试

先启动服务，再（在另一个终端）：

```bash
PORT=3000 npx tsx test/e2e-collab.mts     # WS + 长轮询 + awareness + 并发合并
PORT=3000 npx tsx test/e2e-offline.mts    # 断网编辑 → 重连幂等合并
```

## 关键模块

- `collab/room-manager.ts`：房间连接、二进制握手/广播、权限、awareness、长轮询虚拟连接。
- `collab/room-store.ts`：每房间权威 `Y.Doc` 的内存生命周期（引用计数 + 延迟卸载）。
- `collab/y-persistence.service.ts`：快照 + 追加增量的二进制持久化（无原生依赖）。
- `collab/ws-adapter.ts`：把原生 `ws` 挂到 Nest HTTP server 的 `/coedit`。
- `collab/polling.controller.ts`：join/send/poll/leave 长轮询降级通道。
- `db/pg.service.ts`：文档级权限（块级权限通过 `scope/block_id` 预留）。
- `db/redis.service.ts`：在线 presence（TTL）+ 带实例标记的跨节点 relay。
