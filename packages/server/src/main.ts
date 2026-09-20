import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { Server as HttpServer } from 'node:http';
import { AppModule } from './app.module.js';
import { config } from './config.js';
import { CoeditWsAdapter } from './collab/ws-adapter.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: { origin: true, credentials: true },
  });

  // 等所有 onModuleInit（PG/Redis 连接）跑完，再把原生 ws 服务挂到同一 HTTP server
  await app.init();
  const httpServer = app.getHttpServer() as unknown as HttpServer;
  const wsAdapter = app.get(CoeditWsAdapter);
  wsAdapter.attach(httpServer);

  await app.listen(config.httpPort, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(
    `[coedit] HTTP/REST + 长轮询 :${config.httpPort}  |  WebSocket 路径 ${config.wsPath}`,
  );
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('服务启动失败', err);
  process.exit(1);
});
