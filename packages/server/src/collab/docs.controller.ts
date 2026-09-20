import { Controller, Get, Param } from '@nestjs/common';
import { PgService } from '../db/pg.service.js';

/** 文档元数据（标题/权限）REST 接口。块级权限在迭代 2 扩展 /docs/:id/permissions/blocks */
@Controller('api/docs')
export class DocsController {
  constructor(private readonly pg: PgService) {}

  @Get(':id/permission/:userId')
  async permission(
    @Param('id') id: string,
    @Param('userId') userId: string,
  ): Promise<{ level: string | null }> {
    const level = await this.pg.resolvePermission(id, userId);
    return { level };
  }
}
