# CoEdit · 分布式块级协同编辑器

基于 **Yjs CRDT** 的分布式块级协同编辑系统：离线优先、二进制增量同步、多光标、
自研块渲染引擎（虚拟滚动 + 局部 DOM 更新）、NestJS 协同服务（WebSocket + HTTP 长轮询）。

## 目录结构（npm workspaces monorepo）

```
packages/
├── shared/      公共类型 + 自实现 protobuf 线协议（y-protobuf 兼容信封）+ 用户配色
├── block-core/  块文档模型内核（Yjs 自定义 CRDT 封装 / 注册表 / 剪贴板 / 统一撤销栈）
├── renderer/    自研块渲染引擎（框架无关 DOM，虚拟滚动，远程光标，contenteditable 绑定）
├── client/      Vue3 应用（IndexedDB 持久化 / 离线队列 / WS+长轮询 / awareness）
└── server/      NestJS（房间管理、Yjs 权威宿主、二进制广播、PG 权限、Redis presence/跨节点）
```

## 快速开始

```bash
# 1) 安装并构建库
npm install
npm run build:lib

# 2) 启动基础设施（PostgreSQL + Redis；可选，缺失时服务自动降级为单机内存模式）
docker compose up -d

# 3) 启动后端（默认 :3000；WS 路径 /coedit；REST/长轮询 /api/...）
npm run dev -w @coedit/server        # 或: npm run start -w @coedit/server（需先 build）

# 4) 启动前端（:5173，已配置 /api 与 /coedit 代理到 3000）
npm run dev -w @coedit/client
```

打开 http://localhost:5173 ，输入文档 ID 与昵称进入。多开两个标签页（不同昵称）即可实时协同。

可在顶栏把传输通道切到 **HTTP 长轮询（降级）** 验证 WebSocket 不可用时的降级链路。

## 需求覆盖对照

### 1. 块文档模型内核（`block-core`）
- 段落 / 标题（1-3 级）/ 引用 / 代码块；统一元数据：块 ID（UUIDv4）、类型、`created{at,by}`、`props`。
- 所有块的增 / 删 / 改 / 移动均在 Yjs 事务内完成（`LOCAL_ORIGIN`），天然 CRDT。
- 块结构隔离：每块独立 `Y.Map` + 独立 `Y.Text`；行内样式 bold/italic/underline/strike/code/link/color。
- 全局块复制粘贴：自定义剪贴板 MIME（携带 delta + 元数据，跨文档），粘贴重新生成块 ID，保留行内样式；
  同时写 `text/plain` 兼容系统其它编辑器。
- 扩展注册接口 `BlockRegistry`；`table` / `image` 已以 `reserved` 定义注册（迭代 2 落地，当前拒绝创建）。

### 2. 离线优先与本地持久化（`client/persistence`）
- IndexedDB 存三类数据：`updates`（Yjs 二进制增量）、`snapshots`（压缩快照）、
  `pending`（待同步队列）、`tempstate`（临时 UI 状态）。y-indexeddb 同构语义，自包含实现。
- 断网全量可编辑：本地事务照常提交并落盘；上线后更新走 `pending` 队列（内容指纹幂等去重）。
- 网络恢复：SyncStep1/2 基于 **state vector** 自动合并远端变更，再幂等重放本地增量；
  CRDT 增量重复应用无副作用。
- 统一撤销重做栈（`Y.UndoManager`，只追踪 `LOCAL_ORIGIN`）：在线 / 离线行为一致，
  撤销不会回退掉他人的远端改动。

### 3. 多人实时协同
- WebSocket 文档房间，按 docId 隔离；协议见 `shared/src/protocol.ts`（自实现 protobuf 编解码）。
- 同步消息为 Yjs 二进制增量（SyncStep1/2/Update），替代全量文本；字段布局对齐 y-protobuf。
- 光标 / 选区 awareness 结构化广播（clientId + 单调 clock + JSON presence），
  用户颜色按 id 稳定哈希到等距调色板。
- 并发块新增 / 删除 / 移动由 CRDT 无冲突自动收敛（有专门的骨架竞争压力测试，40 组 clientID）。

### 4. 自研渲染引擎（`renderer`）
- 纯显式 DOM（`createElement`），不依赖富文本框架的 DOM 结构；`contenteditable` 只挂在文本层。
- 监听 Yjs：结构（blocks/order）与块内（Y.Text/props）分离观察，**只重绘受影响块**。
- 虚拟滚动：视口外块不挂载，用高度缓存 + spacer 撑开滚动条，overscan 缓冲。
- 远程光标覆盖层（caret layer）按块内文本偏移测量定位。

### 5. 后端配套（`server`）
- NestJS + 原生 `ws` 挂在同一 HTTP server：REST/长轮询与协同 WS 共用一个端口。
- 服务端每个房间一个权威 `Y.Doc`，重启从二进制持久化恢复（快照 + 追加增量，自动 checkpoint）。
- PostgreSQL：`users / docs / doc_permissions(scope, block_id)`；当前实现文档级 read/write/owner，
  **块级权限通过同一表的 `scope='block', block_id=...` 预留**。
- Redis：在线 presence（带 TTL）+ 跨实例 pub/sub relay（信封带实例 id，丢弃同源消息防回环）。
- PG/Redis 不可用时服务自动降级为单机进程内模式（本地开发体验）。

## 二进制协议要点（`packages/shared/src/protocol.ts`）

```
Envelope { uint32 type = 1; bytes payload = 2; }
  Join / Joined / SyncStep1(stateVector) / SyncStep2(update)
  Update / ServerUpdate(update)        // Yjs 二进制增量
  Awareness(repeated { clientId, clock, json }) / AwarenessSnapshot
  Ping / Pong / Error(code, message)
```

## 关键设计决策（踩坑记录）

1. **块骨架必须延迟初始化**：`BlockDoc` 构造时不立即创建嵌套 `Y.Map/Y.Array/Y.Text`。
   加入已有文档时先吃远端 SyncStep2，再 `ensureInitialized()` 幂等补骨架——
   否则双方在握手前各自创建同名嵌套类型会产生 Yjs Map 键竞争（对彼此不可见的孤立类型）。
2. **服务端每个 Y.Doc 只挂一个 update 广播监听器**，来源连接通过事务 `origin` 标记后排除；
   不能为每个连接各挂一个"排除自己"的监听器（会错误排除别的连接）。
3. **加入已有文档绝不发全量快照**：只有"空房间首个创建者"（远端空 diff 且本地无基线）才发 SyncStep2 全量；
   重连方只发 pending 增量，否则旧快照语义会干扰 CRDT 合并。
4. **跨实例 relay 与本地广播分离**：Yjs 层负责本实例广播（含 origin 排除），
   Redis 只把消息转给其它实例并带实例 id 防回环；Redis 不可用时 relay 为 noop。

## 测试

```bash
# 协议编解码（6）与块 CRDT 内核（9，含 40 组骨架竞争压力、撤销隔离、剪贴板）
node --test --import tsx packages/shared/src/protocol.test.ts
node --test --import tsx packages/block-core/src/block-doc.test.ts

# 端到端（需要先启动 server；默认连 :3000，可用 PORT 覆盖）
#   test/e2e-collab.mts       WS 实时编辑 / 并发块增移合并 / awareness / HTTP 长轮询双向
#   test/e2e-offline.mts      断网编辑 → 重连合并 + 幂等重放
#   test/seed.mts + read-restart.mts   真实服务重启持久化恢复
#   test/verify-persistence.mts        直接校验磁盘持久化文件
cd packages/server
npm run build
YJS_DATA_DIR=./.coedit-data PORT=3000 node dist/main.js &
PORT=3000 npx tsx test/e2e-collab.mts
PORT=3000 npx tsx test/e2e-offline.mts
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WS 端口 |
| `WS_PATH` | `/coedit` | WebSocket 升级路径 |
| `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` | localhost:5432/coedit | PostgreSQL |
| `REDISHOST/REDISPORT` | localhost:6379 | Redis |
| `YJS_DATA_DIR` | `./.coedit-data` | Yjs 二进制持久化目录 |
| `PRESENCE_TTL` | `45` | 在线 presence 缓存 TTL（秒） |

## 迭代 2 扩展点

- 块级权限：`doc_permissions.scope='block' + block_id` 已建表；在 `RoomManager.clientUpdate`
  的 Yjs update 应用前加块级校验（或在 Y.Doc 层用 per-block guard）。
- 表格 / 图片块：`BlockRegistry` 已注册 reserved 定义；存储层已预留 `containers: Y.Map<id, Y.Array>`。
- 图片等二进制资源：上传到对象存储（S3/MinIO），块 `props.src` 存对象 key。
