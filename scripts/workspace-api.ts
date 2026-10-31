import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signalNotesChanged } from './semantic-memory-api';

type Note = { id: string; title: string; content: string; updatedAt: string };
type Task = { id: string; text: string; done: boolean; createdAt: string };
type WorkspaceData = { schema: 1; revision: number; notes: Note[]; tasks: Task[] };
const root = process.cwd();
const runtime = join(root, '.runtime');
const dataPath = join(runtime, 'workspace-data.json');
const backupPath = join(runtime, 'workspace-data.previous.json');
const MAX_REQUEST_BYTES = 1_500_000;
const blank = (): WorkspaceData => ({ schema: 1, revision: 0, notes: [], tasks: [] });

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}
function validDate(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 10 && value.length <= 40 && !Number.isNaN(Date.parse(value));
}
function assertData(input: unknown): asserts input is WorkspaceData {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Некорректный формат локальных данных.');
  const data = input as Record<string, unknown>;
  if (data.schema !== 1 || !Number.isSafeInteger(data.revision) || (data.revision as number) < 0) {
    throw new Error('Неподдерживаемая версия локальных данных.');
  }
  if (!Array.isArray(data.notes) || data.notes.length > 500 || !Array.isArray(data.tasks) || data.tasks.length > 2000) {
    throw new Error('Превышен допустимый объём записей.');
  }
  const ids = new Set<string>();
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
  for (const item of data.notes) {
    if (!item || typeof item !== 'object' || !validId(item.id) || ids.has(item.id)
      || typeof item.title !== 'string' || item.title.length > 200
      || typeof item.content !== 'string' || item.content.length > 100_000 || !validDate(item.updatedAt)) {
      throw new Error('Некорректная заметка в локальных данных.');
    }
    ids.add(item.id);
  }
  for (const item of data.tasks) {
    if (!item || typeof item !== 'object' || !validId(item.id) || ids.has(item.id)
      || typeof item.text !== 'string' || item.text.length > 500
      || typeof item.done !== 'boolean' || !validDate(item.createdAt)) {
      throw new Error('Некорректная задача в локальных данных.');
    }
    ids.add(item.id);
  }
}
function readData(): WorkspaceData {
  if (!existsSync(dataPath)) return blank();
  const contents = readFileSync(dataPath, 'utf8');
  if (Buffer.byteLength(contents, 'utf8') > MAX_REQUEST_BYTES) throw new Error('Файл данных слишком большой. Он не изменён.');
  const data: unknown = JSON.parse(contents);
  assertData(data);
  return data;
}
function authenticated(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  return /^127\.0\.0\.1:\d+$/.test(host)
    && req.headers.origin === 'http://' + host
    && req.headers['x-hayumeri-action'] === '1'
    && req.headers['content-type']?.startsWith('application/json') === true
    && req.headers['sec-fetch-site'] !== 'cross-site';
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_REQUEST_BYTES) throw new Error('Размер запроса превышает 1,5 МБ.');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** Data is local to the Hayumeri directory, not to a particular browser port.
 * .runtime is excluded from Git and protected by the GitHub updater.
 * Writes are serialized inside a single Vite server and use a temporary file.
 */
export function hayumeriWorkspaceApi(): Plugin {
  let writing = false;
  return {
    name: 'hayumeri-local-workspace',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/workspace', async (req, res, next) => {
        if (req.url !== '/data') { next(); return; }
        try {
          if (req.method === 'GET') {
            send(res, 200, readData());
            return;
          }
          if (req.method !== 'POST') { send(res, 405, { error: 'Метод не поддерживается.' }); return; }
          if (!authenticated(req)) { send(res, 403, { error: 'Запрос сохранения отклонён.' }); return; }
          if (writing) { send(res, 409, { error: 'Сохранение уже выполняется.' }); return; }
          const input = await readBody(req);
          assertData(input);
          writing = true;
          try {
            const previous = readData();
            if (input.revision !== previous.revision) {
              send(res, 409, { error: 'Данные изменены в другом окне. Обновите страницу перед сохранением.' });
              return;
            }
            const nextData: WorkspaceData = {
              schema: 1, revision: previous.revision + 1,
              notes: input.notes, tasks: input.tasks
            };
            mkdirSync(runtime, { recursive: true });
            const temp = join(runtime, 'workspace-data-' + process.pid + '.tmp');
            try {
              writeFileSync(temp, JSON.stringify(nextData), { encoding: 'utf8', flag: 'wx' });
              if (existsSync(dataPath)) copyFileSync(dataPath, backupPath);
              renameSync(temp, dataPath);
            } finally {
              if (existsSync(temp)) unlinkSync(temp);
            }
            send(res, 200, nextData);
            // Saving notes never waits for Ollama or Qdrant.
            if (JSON.stringify(previous.notes) !== JSON.stringify(nextData.notes)) signalNotesChanged();
          } finally { writing = false; }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Не удалось обработать данные.';
          const badInput = error instanceof SyntaxError || message.startsWith('Некорректн')
            || message.startsWith('Превышен') || message.startsWith('Размер запроса') || message.startsWith('Неподдерживаемая');
          send(res, badInput ? 400 : 500, { error: message.slice(0, 280) });
        }
      });
    }
  };
}
