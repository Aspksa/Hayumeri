import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const runtime = join(process.cwd(), '.runtime');
const storePath = join(runtime, 'ui-preferences.json');
const backupPath = join(runtime, 'ui-preferences.previous.json');
const allowedRoutes = ['home','notes','tasks','knowledge','memory','graph','agents','chat','disk','system'];
type Density = 'comfortable' | 'compact';
type Preferences = {
  schema: 1;
  revision: number;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  noteListPercent: number;
  editorWidth: number;
  fontScale: number;
  density: Density;
  effects: boolean;
  pinned: string[];
};
const defaults = (): Preferences => ({
  schema: 1, revision: 0, sidebarCollapsed: false, sidebarWidth: 232,
  noteListPercent: 33, editorWidth: 1100, fontScale: 1,
  density: 'comfortable', effects: true, pinned: ['notes', 'tasks']
});
function validate(value: unknown): asserts value is Preferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Неверный формат настроек.');
  const v = value as Record<string, unknown>;
  const integer = (x: unknown, min: number, max: number): boolean =>
    typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
  if (v.schema !== 1 || !integer(v.revision, 0, Number.MAX_SAFE_INTEGER)
      || typeof v.sidebarCollapsed !== 'boolean'
      || !integer(v.sidebarWidth, 206, 340)
      || !integer(v.noteListPercent, 25, 52)
      || !integer(v.editorWidth, 760, 1600)
      || typeof v.fontScale !== 'number' || !Number.isFinite(v.fontScale)
      || v.fontScale < .9 || v.fontScale > 1.3
      || (v.density !== 'comfortable' && v.density !== 'compact')
      || typeof v.effects !== 'boolean'
      || !Array.isArray(v.pinned) || v.pinned.length > allowedRoutes.length
      || v.pinned.some(x => typeof x !== 'string' || !allowedRoutes.includes(x))
      || new Set(v.pinned).size !== v.pinned.length) {
    throw new Error('Некорректные значения настроек интерфейса.');
  }
}
function readPreferences(): Preferences {
  if (!existsSync(storePath)) return defaults();
  const raw = readFileSync(storePath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 16000) throw new Error('Файл настроек слишком большой.');
  const data: unknown = JSON.parse(raw);
  validate(data);
  return data;
}
function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}
function originOk(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  return /^127\.0\.0\.1:\d+$/.test(host)
    && req.headers.origin === 'http://' + host
    && req.headers['x-hayumeri-action'] === '1'
    && req.headers['content-type']?.startsWith('application/json') === true
    && req.headers['sec-fetch-site'] !== 'cross-site';
}
async function receive(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const part of req) {
    const chunk = part as Buffer;
    total += chunk.byteLength;
    if (total > 16000) throw new Error('Запрос настроек слишком большой.');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
}
export function hayumeriPreferencesApi(): Plugin {
  let busy = false;
  return {
    name: 'hayumeri-local-preferences',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/preferences', async (req, res, next) => {
        if (req.url !== '/data') { next(); return; }
        try {
          if (req.method === 'GET') { respond(res, 200, readPreferences()); return; }
          if (req.method !== 'POST') { respond(res, 405, { error: 'Метод не поддерживается.' }); return; }
          if (!originOk(req)) { respond(res, 403, { error: 'Изменение настроек отклонено.' }); return; }
          if (busy) { respond(res, 409, { error: 'Другое изменение ещё сохраняется.' }); return; }
          const raw = await receive(req);
          validate(raw);
          busy = true;
          try {
            const previous = readPreferences();
            if (previous.revision !== raw.revision) {
              respond(res, 409, { error: 'Настройки изменены в другом окне. Перезагрузите страницу.' });
              return;
            }
            const updated: Preferences = {
              schema: 1,
              revision: previous.revision + 1,
              sidebarCollapsed: raw.sidebarCollapsed,
              sidebarWidth: raw.sidebarWidth,
              noteListPercent: raw.noteListPercent,
              editorWidth: raw.editorWidth,
              fontScale: raw.fontScale,
              density: raw.density,
              effects: raw.effects,
              pinned: raw.pinned
            };
            mkdirSync(runtime, { recursive: true });
            const temporary = join(runtime, 'ui-preferences-' + process.pid + '.tmp');
            try {
              writeFileSync(temporary, JSON.stringify(updated), { encoding: 'utf8', flag: 'wx' });
              if (existsSync(storePath)) copyFileSync(storePath, backupPath);
              renameSync(temporary, storePath);
            } finally {
              if (existsSync(temporary)) unlinkSync(temporary);
            }
            respond(res, 200, updated);
          } finally { busy = false; }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Не удалось прочитать настройки.';
          const invalid = error instanceof SyntaxError || message.startsWith('Неверный')
            || message.startsWith('Некорректные') || message.startsWith('Запрос настроек');
          respond(res, invalid ? 400 : 500, { error: message.slice(0, 240) });
        }
      });
    }
  };
}
