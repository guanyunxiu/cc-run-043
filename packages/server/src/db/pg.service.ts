import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { config } from '../config.js';

export interface DocPermissionRow {
  doc_id: string;
  user_id: string;
  /** read | write | owner */
  level: 'read' | 'write' | 'owner';
}

/**
 * PostgreSQL 数据访问：
 *  - users           用户
 *  - docs            文档元数据
 *  - doc_permissions 全局文档级读写权限（块级权限在迭代 2 于同一表扩展 scope）
 *
 * 服务启动时幂等建表；PG 不可用时降级为内存模式（仅本地开发）。
 */
@Injectable()
export class PgService implements OnModuleDestroy {
  private readonly logger = new Logger(PgService.name);
  pool: Pool | null = null;
  private memoryFallback = new Map<string, DocPermissionRow[]>();

  async onModuleInit(): Promise<void> {
    const pool = new Pool({ ...config.pg, max: 4, connectionTimeoutMillis: 1500 });
    pool.on('error', () => undefined);
    try {
      await pool.query('select 1');
      await this.schemaWith(pool);
      this.pool = pool;
      this.logger.log('PostgreSQL 已连接并完成 schema 初始化');
    } catch (err) {
      this.logger.warn(`PostgreSQL 不可用，降级为内存权限模式：${(err as Error).message}`);
      await pool.end().catch(() => undefined);
      this.pool = null;
    }
  }

  private async schemaWith(pool: Pool): Promise<void> {
    await pool.query(`
      create table if not exists users (
        id text primary key,
        name text not null,
        color text,
        created_at timestamptz not null default now()
      );
      create table if not exists docs (
        id text primary key,
        title text not null default '',
        owner_id text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists doc_permissions (
        doc_id text not null references docs(id) on delete cascade,
        user_id text not null,
        level text not null check (level in ('read','write','owner')),
        -- scope/block_id 为迭代 2 的块级权限预留：默认 'doc' 表示文档级
        scope text not null default 'doc',
        block_id text,
        primary key (doc_id, user_id, scope, block_id)
      );
    `);
  }

  async resolvePermission(docId: string, userId: string): Promise<'read' | 'write' | 'owner' | null> {
    if (this.pool) {
      const r = await this.pool.query<DocPermissionRow>(
        `select doc_id, user_id, level from doc_permissions
         where doc_id = $1 and user_id = $2 and scope = 'doc'`,
        [docId, userId],
      );
      return (r.rows[0]?.level as DocPermissionRow['level']) ?? null;
    }
    const list = this.memoryFallback.get(docId) ?? [];
    return list.find((r) => r.user_id === userId)?.level ?? null;
  }

  async ensureDoc(docId: string, ownerId: string, title = ''): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        `insert into docs (id, owner_id, title) values ($1,$2,$3)
         on conflict (id) do nothing`,
        [docId, ownerId, title],
      );
      await this.pool.query(
        `insert into doc_permissions (doc_id, user_id, level) values ($1,$2,'owner')
         on conflict do nothing`,
        [docId, ownerId],
      );
    } else {
      if (!this.memoryFallback.has(docId)) {
        this.memoryFallback.set(docId, [{ doc_id: docId, user_id: ownerId, level: 'owner' }]);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
