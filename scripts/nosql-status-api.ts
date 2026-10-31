import type { Plugin } from 'vite';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

type NoSqlState = 'pending' | 'docker-missing' | 'docker-starting' | 'docker-unavailable'
  | 'starting' | 'running' | 'scaling' | 'degraded' | 'memory-warning'
  | 'disk-warning' | 'credentials-missing' | 'error' | 'stale';
const knownStates = new Set<NoSqlState>([
  'pending', 'docker-missing', 'docker-starting', 'docker-unavailable',
  'starting', 'running', 'scaling', 'degraded', 'memory-warning',
  'disk-warning', 'credentials-missing', 'error', 'stale'
]);
const services = new Set(['mongodb', 'redis', 'neo4j', 'qdrant']);
const path = join(process.cwd(), '.runtime', 'nosql-auto-status.json');

export function readNoSqlStatus(): Record<string, unknown> {
  const pending = {
    schema: 1, automatic: true, state: 'pending', profile: 'balanced',
    message: 'Автоматическая проверка NoSQL ещё не завершилась.',
    running: [] as string[], diskFreeGiB: -1, updatedAt: null as string | null
  };
  if (!existsSync(path)) return pending;
  try {
    if (statSync(path).size > 12000) throw new Error('Status file too large');
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid state');
    const state = data as Record<string, unknown>;
    const stamped = typeof state.updatedAt === 'string' ? Date.parse(state.updatedAt) : NaN;
    if (state.schema !== 1 || state.automatic !== true || typeof state.state !== 'string'
        || !knownStates.has(state.state as NoSqlState)
        || !Array.isArray(state.running)
        || state.running.some(value => typeof value !== 'string' || !services.has(value))
        || typeof state.message !== 'string' || state.message.length > 500
        || (state.profile !== 'balanced' && state.profile !== 'growth')
        || typeof state.diskFreeGiB !== 'number' || !Number.isFinite(state.diskFreeGiB)
        || !Number.isFinite(stamped)) throw new Error('Invalid schema');
    const stale = Date.now() - stamped > 10 * 60_000 || stamped - Date.now() > 60_000;
    return {
      schema: 1, automatic: true, state: stale ? 'stale' : state.state,
      message: stale ? 'Мониторинг NoSQL не обновлялся больше десяти минут. Текущее состояние неизвестно.' : state.message,
      profile: state.profile, running: stale ? [] : state.running,
      diskFreeGiB: state.diskFreeGiB, updatedAt: state.updatedAt
    };
  } catch {
    return { ...pending, state: 'error', message: 'Не удалось прочитать файл состояния NoSQL; данные баз не изменены.' };
  }
}

export function hayumeriNoSqlStatusApi(): Plugin {
  return {
    name: 'hayumeri-nosql-status',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/nosql/status', (req, res, next) => {
        if (req.url !== '/') { next(); return; }
        if (req.method !== 'GET') {
          res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(JSON.stringify(readNoSqlStatus()));
      });
    }
  };
}
