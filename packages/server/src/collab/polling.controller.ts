import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { fromBase64, toBase64 } from '@coedit/shared';
import { RoomManager } from './room-manager.js';

/**
 * HTTP 长轮询降级通道，路由：
 *   POST /api/rooms/:docId/join?clientId=
 *   POST /api/rooms/:docId/send?clientId=     body: { message: base64 }
 *   GET  /api/rooms/:docId/poll?clientId=&cursor=   （挂起至有消息或超时）
 *   POST /api/rooms/:docId/leave?clientId=
 *
 * 负载全部是 protobuf 信封的 base64，与 WebSocket 二进制帧一一对应。
 */
@Controller('api/rooms')
export class PollingController {
  constructor(private readonly rooms: RoomManager) {}

  @Post(':docId/join')
  async join(
    @Param('docId') docId: string,
    @Query('clientId') clientId: string,
    @Body() body: { presence?: string },
  ): Promise<{ ok: true }> {
    await this.rooms.pollJoin(docId, Number(clientId) >>> 0, body.presence ?? '');
    return { ok: true };
  }

  @Post(':docId/send')
  async send(
    @Param('docId') docId: string,
    @Query('clientId') clientId: string,
    @Body() body: { message?: string },
  ): Promise<{ ok: true }> {
    if (!body.message) return { ok: true };
    await this.rooms.pollSend(docId, Number(clientId) >>> 0, fromBase64(body.message));
    return { ok: true };
  }

  @Get(':docId/poll')
  async poll(
    @Param('docId') docId: string,
    @Query('clientId') clientId: string,
    @Query('cursor') cursor: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const result = await this.rooms.pollFetch(
        docId,
        Number(clientId) >>> 0,
        Number(cursor ?? 0) || 0,
      );
      res.json({
        cursor: result.cursor,
        messages: result.messages.map((m) => toBase64(m)),
      });
    } catch {
      res.status(409).json({ error: 'not joined', cursor: Number(cursor ?? 0) || 0, messages: [] });
    }
  }

  @Post(':docId/leave')
  async leave(
    @Param('docId') docId: string,
    @Query('clientId') clientId: string,
  ): Promise<{ ok: true }> {
    await this.rooms.pollLeave(docId, Number(clientId) >>> 0);
    return { ok: true };
  }
}
