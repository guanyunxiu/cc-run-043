export const config = {
  httpPort: Number(process.env.PORT ?? 3000),
  wsPath: process.env.WS_PATH ?? '/coedit',
  pg: {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'coedit',
    password: process.env.PGPASSWORD ?? 'coedit',
    database: process.env.PGDATABASE ?? 'coedit',
  },
  redis: {
    host: process.env.REDISHOST ?? 'localhost',
    port: Number(process.env.REDISPORT ?? 6379),
  },
  presenceTtlSeconds: Number(process.env.PRESENCE_TTL ?? 45),
  /** 无 PG 时的开发降级：跳过权限校验，仍可体验协同（生产必须连接 PG） */
  allowAnonymous: process.env.ALLOW_ANONYMOUS === '1' || true,
} as const;
