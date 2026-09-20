import { Module } from '@nestjs/common';
import { PgService } from './db/pg.service.js';
import { RedisService } from './db/redis.service.js';
import { YPersistenceService } from './collab/y-persistence.service.js';
import { RoomStore } from './collab/room-store.js';
import { RoomManager } from './collab/room-manager.js';
import { CoeditWsAdapter } from './collab/ws-adapter.js';
import { PollingController } from './collab/polling.controller.js';
import { DocsController } from './collab/docs.controller.js';

@Module({
  controllers: [PollingController, DocsController],
  providers: [
    PgService,
    RedisService,
    YPersistenceService,
    RoomStore,
    RoomManager,
    CoeditWsAdapter,
  ],
})
export class AppModule {}
