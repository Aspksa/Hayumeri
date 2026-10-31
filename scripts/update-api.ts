import type { Plugin } from 'vite';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const repo = 'Aspksa/Hayumeri';
const root = process.cwd();
const runtime = join(root, '.runtime');
const stateFile = join(runtime, 'update-state.json');
const requestFile = join(runtime, 'update-request.json');
const github = 'https://api.github.com/repos/' + repo;
type GithubUpdate = { sha: string; message: string; url: string; checkedAt: number };
let latest: GithubUpdate | null = null;
let updating = false;

function readJson(path: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; }
  catch { return {}; }
}
function installedCommit(): string {
  const saved = readJson(stateFile).commit;
  const baseline = readJson(join(root, 'config', 'update.json')).baselineCommit;
  return typeof saved === 'string' && /^[a-f0-9]{40}$/.test(saved)
    ? saved : typeof baseline === 'string' && /^[a-f0-9]{40}$/.test(baseline) ? baseline : '';
}
function send(res: ServerResponse, code: number, data: Record<string, unknown>): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
async function fetchGithub(): Promise<GithubUpdate> {
  const response = await fetch(github + '/commits/main', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Hayumeri-local-updater' },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('GitHub недоступен (HTTP ' + response.status + ').');
  const body = await response.json() as { sha?: string; html_url?: string; commit?: { message?: string } };
  if (!body.sha || !/^[a-f0-9]{40}$/.test(body.sha)) throw new Error('GitHub вернул некорректный идентификатор версии.');
  const result = {
    sha: body.sha,
    url: 'https://github.com/' + repo + '/commit/' + body.sha,
    message: (body.commit?.message ?? '').split('\n')[0].slice(0, 200),
    checkedAt: Date.now()
  };
  latest = result;
  return result;
}
function authenticated(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  const origin = req.headers.origin ?? '';
  return /^127\.0\.0\.1:\d+$/.test(host)
    && origin === 'http://' + host
    && req.headers['x-hayumeri-action'] === '1'
    && req.headers['content-type']?.startsWith('application/json') === true
    && req.headers['sec-fetch-site'] !== 'cross-site';
}
async function bodyJson(req: IncomingMessage): Promise<{ sha?: string }> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4096) throw new Error('Слишком большой запрос.');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as { sha?: string };
}
function availableToApply(): boolean {
  return process.platform === 'win32' && process.env.HAYUMERI_LAUNCHER === '1'
    && !existsSync(join(root, '.git')) && existsSync(join(root, 'scripts', 'apply-update.ps1'));
}
function currentInfo() {
  const current = installedCommit();
  const pkg = readJson(join(root, 'package.json'));
  return {
    repository: repo, current, version: String(pkg.version || '0.1.0'),
    canApply: availableToApply(), busy: updating,
    latest: latest ? { sha: latest.sha, url: latest.url, message: latest.message } : null,
    hasUpdate: Boolean(latest && current !== latest.sha),
    note: !availableToApply() ? 'Автоматическое применение доступно только при запуске Hayumeri.bat из обычной папки (не Git-клона).' : ''
  };
}
export function hayumeriUpdateApi(): Plugin {
  return {
    name: 'hayumeri-local-github-update',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/update', async (req, res, next) => {
        try {
          if (req.method === 'GET' && req.url === '/status') {
            send(res, 200, currentInfo()); return;
          }
          if (req.method === 'POST' && (req.url === '/check' || req.url === '/apply')) {
            if (!authenticated(req)) { send(res, 403, { error: 'Запрос обновления отклонён: неверный источник.' }); return; }
            if (req.url === '/check') {
              await bodyJson(req);
              const remote = await fetchGithub();
              send(res, 200, { ...currentInfo(), latest: remote }); return;
            }
            if (updating) { send(res, 409, { error: 'Обновление уже запущено.' }); return; }
            if (!availableToApply()) { send(res, 409, { error: 'Обновление через сайт недоступно в текущем режиме запуска.' }); return; }
            const body = await bodyJson(req);
            if (!latest || Date.now() - latest.checkedAt > 10 * 60_000 || body.sha !== latest.sha) {
              send(res, 409, { error: 'Сначала проверьте доступную версию в GitHub.' }); return;
            }
            if (installedCommit() === latest.sha) { send(res, 409, { error: 'Уже установлена актуальная версия.' }); return; }
            mkdirSync(runtime, { recursive: true });
            const tmp = requestFile + '.tmp';
            writeFileSync(tmp, JSON.stringify({ commit: latest.sha, requestedAt: new Date().toISOString() }), 'utf8');
            renameSync(tmp, requestFile);
            const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
            const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
              '-File', join(root, 'scripts', 'apply-update.ps1'), '-Commit', latest.sha, '-ParentPid', String(process.pid)],
              { cwd: root, detached: true, windowsHide: true, stdio: 'ignore' });
            if (!child.pid) throw new Error('Не удалось запустить установщик обновлений.');
            child.unref();
            updating = true;
            send(res, 202, { accepted: true, message: 'Подготовка обновления. Приложение будет перезапущено.' });
            setTimeout(() => process.exit(75), 550).unref();
            return;
          }
          next();
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Неизвестная ошибка проверки обновления.';
          send(res, 500, { error: message.slice(0, 250) });
        }
      });
    }
  };
}
