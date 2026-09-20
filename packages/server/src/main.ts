import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { WsAdapter } from '@nestjs/platform-ws';
import { config } from './config.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn'],
  });
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableCors({ origin: config.corsOrigin, credentials: true });
  app.setGlobalPrefix('api');

  await app.listen(config.port);
  console.log(`[blockeditor] HTTP + WS 服务已启动: http://localhost:${config.port}`);
}

void bootstrap();
