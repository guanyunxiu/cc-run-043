import { Injectable, Logger } from '@nestjs/common';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { URL } from 'node:url';
import { config } from '../config.js';
import { RoomManager } from './room-manager.js';

/** 把查询参数挂到连接对象上，供 RoomManager 使用 */
export interface CoeditSocket extends WebSocket {
  coeditQuery?: URLSearchParams;
}

/**
 * 把原生 ws.Server 挂到 Nest 的同一个 HTTP server 上，并按路径 /coedit 过滤。
 * 这样：
 *  - HTTP（REST / 长轮询）与协同 WebSocket 共用一个端口（3000）；
 *  - 升级握手不经过 Express，二进制吞吐最优；
 *  - 协同逻辑完全由 RoomManager 掌控，等价于二次封装的 y-websocket 服务。
 */
@Injectable()
export class CoeditWsAdapter {
  private readonly logger = new Logger(CoeditWsAdapter.name);
  private wss: WebSocketServer | null = null;

  constructor(private readonly rooms: RoomManager) {}

  attach(httpServer: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== config.wsPath) {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        (ws as CoeditSocket).coeditQuery = url.searchParams;
        // @types/ws 的 emit 重载存在 this 泛型逆变问题，此处参数在运行时正确
        (this.wss as unknown as { emit: (e: string, ...a: unknown[]) => void })
          .emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws: WebSocket) => {
      void this.rooms.handleConnection(ws, (ws as CoeditSocket).coeditQuery ?? new URLSearchParams());
    });

    this.logger.log(`协同 WebSocket 已挂载于 ${config.wsPath}（二进制增量协议）`);
  }
}
