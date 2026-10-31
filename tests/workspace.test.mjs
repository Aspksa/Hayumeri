import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const main = read('src/main.ts');
const ui = read('src/workspace.ts');
const css = read('src/workspace.css');
const server = read('scripts/workspace-api.ts');
const vite = read('vite.config.ts');

test('real workspace shell preserves premium home and GitHub updater', () => {
  for (const id of ['home-view', 'workspace-view', 'workspace-navigation', 'workspace-live-status', 'update-trigger']) {
    assert.match(main, new RegExp('id="' + id + '"'));
  }
  assert.match(main, /initWorkspaceUi\(\)/);
  assert.match(main, /initUpdateUi\(\)/);
  assert.match(main, /import '\.\/workspace\.css'/);
  assert.match(ui, /window\.addEventListener\('hashchange'/);
  assert.match(ui, /aria-current="page"/);
});

test('notes and tasks are actual editable workflows, not fictitious status screens', () => {
  for (const name of ['notes', 'tasks', 'knowledge', 'memory', 'graph', 'agents', 'chat', 'disk', 'system']) {
    assert.match(ui, new RegExp('\\b' + name + ': \\{'));
  }
  for (const action of ['new-note', 'save-note', 'delete-note', 'select-note', 'toggle-task', 'delete-task']) {
    assert.match(ui, new RegExp(action));
  }
  assert.match(ui, /workspaceRequest\(next\)/);
  assert.match(ui, /МОДУЛЬ НЕ ПОДКЛЮЧЁН/);
  assert.match(ui, /Данные сохраняются после каждого действия/);
  assert.match(ui, /Заметка не сохранена/);
  assert.match(ui, /escapeHtml/);
});

test('storage lives under protected runtime with validation, backup and revision conflicts', () => {
  assert.match(server, /join\(root, '\.runtime'\)/);
  assert.match(server, /workspace-data\.json/);
  assert.match(server, /workspace-data\.previous\.json/);
  assert.match(server, /copyFileSync/);
  assert.match(server, /renameSync/);
  assert.match(server, /input\.revision !== previous\.revision/);
  assert.match(server, /send\(res, 409/);
  assert.match(server, /send\(res, 403/);
  assert.match(server, /x-hayumeri-action/);
  assert.match(server, /req\.headers\.origin/);
  assert.match(server, /MAX_REQUEST_BYTES/);
  assert.match(vite, /hayumeriWorkspaceApi/);
});

test('workspace remains responsive and gold-on-black with accessible navigation', () => {
  assert.match(css, /\.app-layout/);
  assert.match(css, /\.workspace-nav-item\.is-active/);
  assert.match(css, /\.note-layout/);
  assert.match(css, /\.task-list/);
  assert.match(css, /\.future-status/);
  assert.match(css, /var\(--gold\)/);
  assert.match(css, /@media \(max-width: 930px\)/);
  assert.match(css, /@media \(max-width: 600px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(main, /<nav class="workspace-navigation"/);
});
