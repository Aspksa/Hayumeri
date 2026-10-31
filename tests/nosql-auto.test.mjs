import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const worker = read('scripts/nosql-auto.ps1');
const launcher = read('scripts/start.ps1');
const api = read('scripts/nosql-status-api.ts');
const config = read('vite.config.ts');
const workspace = read('src/workspace.ts');
const main = read('src/main.ts');
const workflow = read('.github/workflows/windows-launch.yml');

test('automatic four-database lifecycle starts alongside working BAT site, not before readiness', () => {
  assert.match(worker, /^\uFEFFparam\(/);
  assert.match(worker, /ParentStartTicks/);
  assert.match(worker, /Parent-IsAlive/);
  assert.match(worker, /Threading\.Mutex/);
  assert.match(worker, /Compose-Running/);
  assert.match(worker, /Start-DockerDesktop/);
  assert.match(worker, /Start-Stack/);
  assert.match(worker, /nosql-auto-status\.json/);
  assert.match(worker, /Write-State 'docker-missing'/);
  assert.match(worker, /Write-State 'docker-unavailable'/);
  assert.match(launcher, /function Start-NoSqlAutopilot/);
  assert.match(launcher, /\$env:HAYUMERI_NOSQL_DISABLE/);
  assert.match(launcher, /Start-Process -FilePath \$ps/);
  const ready = launcher.indexOf("Set-LaunchStatus 'РАБОТАЕТ'");
  const start = launcher.indexOf('                Start-NoSqlAutopilot');
  assert.ok(ready > 0 && start > ready, 'worker starts only after the web server is healthy');
  assert.match(launcher, /\[ПРЕДУПРЕЖДЕНИЕ\] Не удалось запустить NoSQL-автоматику/);
});

test('memory adaptation is guarded, non-destructive and respects human choices', () => {
  assert.match(worker, /\$memory\.total -ge 24GB|\$memory\.total -ge 24GB/);
  assert.match(worker, /\$memory\.free -ge 9GB/);
  assert.match(worker, /\$dockerBytes -ge 12GB/);
  assert.match(worker, /\$mem\.free -lt 7GB/);
  assert.match(worker, /\$value -ge 85/);
  assert.match(worker, /\$cycles\.Value -ge 3/);
  assert.match(worker, /Test-Path -LiteralPath \$profileFile/);
  assert.match(worker, /\$disk -ge 10/);
  assert.match(worker, /\$disk -lt 3/);
  assert.match(worker, /Has-ExistingVolumes/);
  assert.match(worker, /credentials-missing/);
  assert.doesNotMatch(worker, /down\s+--volumes|down\s+-v|volume\s+rm|Remove-Item -LiteralPath \$credentialsFile/);
});

test('automatic status endpoint contains only non-secret fields and detects staleness', () => {
  assert.match(api, /Cache-Control': 'no-store'/);
  assert.match(api, /req\.method !== 'GET'/);
  assert.match(api, /readNoSqlStatus/);
  assert.match(api, /10 \* 60_000/);
  assert.match(api, /state: stale \? 'stale'/);
  assert.match(api, /schema: 1, automatic: true/);
  assert.doesNotMatch(api, /process\.env|readFileSync\(.*env\.nosql|QDRANT_API_KEY|REDIS_PASSWORD/);
  assert.match(config, /hayumeriNoSqlStatusApi\(\)/);
});

test('System page displays actual four-container status and never labels containers healthy without authentication checks', () => {
  assert.match(main, /import '\.\/nosql\.css'/);
  assert.match(workspace, /fetch\('\/api\/nosql\/status'/);
  assert.match(workspace, /function renderSystem\(\)/);
  assert.match(workspace, /'mongodb', 'MongoDB'/);
  assert.match(workspace, /'redis', 'Redis'/);
  assert.match(workspace, /'neo4j', 'Neo4j'/);
  assert.match(workspace, /'qdrant', 'Qdrant'/);
  assert.match(workspace, /Контейнер запущен/);
  assert.match(workspace, /не означает, что авторизация/);
  assert.match(workspace, /setInterval\(\(\) =>/);
  assert.match(workflow, /scripts\/nosql-auto\.ps1/);
  assert.match(workflow, /api\/nosql\/status/);
});
