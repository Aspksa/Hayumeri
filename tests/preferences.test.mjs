import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const main = read('src/main.ts');
const ui = read('src/personalization.ts');
const style = read('src/personalization.css');
const workspace = read('src/workspace.ts');
const api = read('scripts/preferences-api.ts');
const vite = read('vite.config.ts');
const browser = read('tests/viewport-smoke.mjs');

test('workspace controls and commands remain accessible from existing app shell', () => {
  for (const id of ['sidebar-toggle','sidebar-resize','settings-trigger','command-trigger']) {
    assert.match(main, new RegExp('id="' + id + '"'));
  }
  assert.match(main, /initPersonalizationUi\(\)/);
  assert.match(main, /initWorkspaceUi\(\)/);
  assert.match(main, /initUpdateUi\(\)/);
  assert.match(ui, /Ctrl\+K/);
  assert.match(ui, /Ctrl\+B/);
  assert.match(ui, /case 'fontScale'/);
  assert.match(ui, /setPreferences/);
  assert.match(ui, /'hayumeri:toggle-pin'/);
  assert.match(ui, /command-item/);
  assert.match(ui, /showModal\(\)/);
});

test('pinned route controls and note-panel resizing do not replace the note editor', () => {
  assert.match(workspace, /workspace-nav-row/);
  assert.match(workspace, /data-pin-route/);
  assert.match(workspace, /aria-pressed/);
  assert.match(workspace, /hayumeri:preferences-change/);
  assert.match(workspace, /getPreferences\(\)\.pinned/);
  assert.match(workspace, /class="note-resize"/);
  assert.match(workspace, /setPreferences\(\{ noteListPercent/);
  assert.match(workspace, /event\.code === 'KeyS'/);
  assert.match(workspace, /Есть несохранённые изменения/);
});

test('personal settings are stored beside project across port changes, with safe validation', () => {
  assert.match(api, /join\(process\.cwd\(\), '\.runtime'\)/);
  assert.match(api, /ui-preferences\.json/);
  assert.match(api, /ui-preferences\.previous\.json/);
  assert.match(api, /previous\.revision !== raw\.revision/);
  assert.match(api, /respond\(res, 409/);
  assert.match(api, /respond\(res, 403/);
  assert.match(api, /req\.headers\.origin/);
  assert.match(api, /copyFileSync/);
  assert.match(api, /renameSync/);
  assert.match(vite, /hayumeriPreferencesApi\(\)/);
  assert.doesNotMatch(api, /localStorage/);
});

test('responsive compact and accessibility rules coexist with monitor layouts', () => {
  assert.match(main, /import '\.\/personalization\.css'/);
  assert.match(style, /\.app-layout\[data-sidebar-collapsed="true"\]/);
  assert.match(style, /\.note-layout/);
  assert.match(style, /var\(--ui-sidebar-width\)/);
  assert.match(style, /\.personal-dialog/);
  assert.match(style, /\.command-dialog/);
  assert.match(style, /@media \(max-width: 930px\)/);
  assert.match(style, /@media \(max-width: 600px\)/);
  assert.match(style, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(browser, /persisted settings, sidebar collapse, command filtering and pinned routes/);
});
