import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const text = path => readFileSync(new URL(path, root), 'utf8');
const main = text('src/main.ts');
const ui = text('src/update-ui.ts');
const vite = text('vite.config.ts');
const api = text('scripts/update-api.ts');
const worker = text('scripts/apply-update.ps1');
const launcher = text('scripts/start.ps1');
const config = JSON.parse(text('config/update.json'));

test('update icon lives in the top-right site header', () => {
  assert.match(main, /topbar-actions/);
  assert.match(main, /id="update-trigger"/);
  assert.match(main, /aria-label="Обновления проекта"/);
  assert.match(main, /initUpdateUi/);
  assert.match(ui, /showModal/);
  assert.match(ui, /Проверить GitHub/);
  assert.match(ui, /Установить обновление/);
  assert.match(ui, /window.confirm/);
  assert.match(ui, /role="status"/);
});

test('server-only API checks GitHub and refuses cross-origin update commands', () => {
  assert.match(vite, /hayumeriUpdateApi/);
  assert.match(api, /Aspksa\/Hayumeri/);
  assert.match(api, /commits\/main/);
  assert.match(api, /authenticated\(req\)/);
  assert.match(api, /x-hayumeri-action/);
  assert.match(api, /sec-fetch-site/);
  assert.match(api, /Content-Type/);
  assert.match(api, /req\.headers\.origin/);
  assert.match(api, /HAYUMERI_LAUNCHER/);
  assert.match(api, /'\/apply'/);
  assert.match(api, /process\.exit\(75\)/);
});

test('installer stages exact GitHub commit and verifies git tree objects', () => {
  assert.match(worker, /codeload\.github\.com\/Aspksa\/Hayumeri\/zip/);
  assert.match(worker, /git\/commits\//);
  assert.match(worker, /git\/trees\//);
  assert.match(worker, /Sha1Blob/);
  assert.match(worker, /ZipFile]::OpenRead/);
  assert.match(worker, /RelativeSafe/);
  assert.match(worker, /ProtectedPath/);
  assert.match(worker, /100MB/);
  assert.match(worker, /250MB/);
});

test('rollback preserves user data and restart only after health check', () => {
  assert.match(worker, /Restore-Backup/);
  assert.match(worker, /restore\.json/);
  assert.match(worker, /Wait-ForSite/);
  assert.match(worker, /ОТКАТ/);
  for (const path of ['.runtime', 'node_modules', 'logs', 'vault', 'data', 'config/launcher.json']) {
    assert.ok(worker.includes(path), path);
  }
  assert.doesNotMatch(worker, /Remove-Item -LiteralPath \$root -Recurse/);
  assert.match(launcher, /HAYUMERI_LAUNCHER/);
  assert.match(launcher, /\$server\.ExitCode -eq 75/);
  assert.match(launcher, /ОБНОВЛЕНИЕ/);
  assert.match(config.baselineCommit, /^[a-f0-9]{40}$/);
});

test('Windows PowerShell installer has UTF-8 BOM for Russian messages', () => {
  const bytes = readFileSync(new URL('scripts/apply-update.ps1', root));
  assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
});
