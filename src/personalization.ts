export type WorkspaceRoute = 'home' | 'notes' | 'tasks' | 'knowledge' | 'memory' | 'graph' | 'agents' | 'chat' | 'disk' | 'system';
export type Preferences = {
  schema: 1;
  revision: number;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  noteListPercent: number;
  editorWidth: number;
  fontScale: number;
  density: 'comfortable' | 'compact';
  effects: boolean;
  pinned: WorkspaceRoute[];
};
const routeTitles: Record<WorkspaceRoute, string> = {
  home: 'Главная', notes: 'Заметки', tasks: 'Задачи',
  knowledge: 'Знания', memory: 'Память', graph: 'Граф связей',
  agents: 'Агенты', chat: 'Чат', disk: 'Диск', system: 'Система'
};
const defaults = (): Preferences => ({
  schema: 1, revision: 0, sidebarCollapsed: false, sidebarWidth: 232,
  noteListPercent: 33, editorWidth: 1100, fontScale: 1,
  density: 'comfortable', effects: true, pinned: ['notes', 'tasks']
});
let state = defaults();
let initialized = false;
let ready = false;
let modifiedBeforeLoad = false;
let saving = false;
let changedSinceSave = false;
let saveTimer: number | undefined;
let saveError = '';
const emit = (): void => window.dispatchEvent(new Event('hayumeri:preferences-change'));
const htmlEscape = (value: string): string => value.replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[c]!);
export function getPreferences(): Readonly<Preferences> { return state; }

function apply(): void {
  document.documentElement.style.setProperty('--ui-sidebar-width', state.sidebarWidth + 'px');
  document.documentElement.style.setProperty('--ui-note-list', state.noteListPercent + '%');
  document.documentElement.style.setProperty('--ui-editor-max', state.editorWidth + 'px');
  document.documentElement.style.setProperty('--ui-font-scale', String(state.fontScale));
  document.body.dataset.uiDensity = state.density;
  document.body.dataset.uiEffects = state.effects ? 'on' : 'off';
  document.querySelector<HTMLElement>('.app-layout')?.setAttribute('data-sidebar-collapsed', String(state.sidebarCollapsed));
  const toggle = document.querySelector<HTMLButtonElement>('#sidebar-toggle');
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(!state.sidebarCollapsed));
    toggle.setAttribute('aria-label', state.sidebarCollapsed ? 'Развернуть боковое меню' : 'Свернуть боковое меню');
    toggle.title = state.sidebarCollapsed ? 'Развернуть боковое меню (Ctrl+B)' : 'Свернуть боковое меню (Ctrl+B)';
  }
  const resize = document.querySelector<HTMLElement>('#sidebar-resize');
  if (resize) resize.setAttribute('aria-valuenow', String(state.sidebarWidth));
  emit();
}
export function setPreferences(patch: Partial<Omit<Preferences, 'schema' | 'revision'>>, persist = true): void {
  state = { ...state, ...patch };
  if (!ready) modifiedBeforeLoad = true;
  apply();
  if (persist) {
    changedSinceSave = true;
    if (ready) scheduleSave();
  }
}
function validation(value: unknown): value is Preferences {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.schema === 1 && typeof v.revision === 'number'
    && Number.isSafeInteger(v.revision) && v.revision >= 0
    && typeof v.sidebarCollapsed === 'boolean'
    && Number.isInteger(v.sidebarWidth) && (v.sidebarWidth as number) >= 206 && (v.sidebarWidth as number) <= 340
    && Number.isInteger(v.noteListPercent) && (v.noteListPercent as number) >= 25 && (v.noteListPercent as number) <= 52
    && Number.isInteger(v.editorWidth) && (v.editorWidth as number) >= 760 && (v.editorWidth as number) <= 1600
    && typeof v.fontScale === 'number' && Number.isFinite(v.fontScale) && v.fontScale >= .9 && v.fontScale <= 1.3
    && (v.density === 'comfortable' || v.density === 'compact')
    && typeof v.effects === 'boolean' && Array.isArray(v.pinned)
    && v.pinned.length <= 10 && v.pinned.every(x => typeof x === 'string' && x in routeTitles)
    && new Set(v.pinned).size === v.pinned.length;
}
async function request(body?: Preferences): Promise<Preferences> {
  const response = await fetch('/api/preferences/data', {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', 'X-Hayumeri-Action': '1' } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const record = result as { error?: string };
    throw new Error(record.error ?? 'Не удалось сохранить настройки.');
  }
  if (!validation(result)) throw new Error('Сервер вернул некорректные настройки.');
  return result;
}
function report(message: string): void {
  const status = document.querySelector<HTMLElement>('#settings-status');
  if (status) status.textContent = message;
  const live = document.querySelector<HTMLElement>('#workspace-live-status');
  if (live) live.textContent = message;
}
function scheduleSave(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { saveTimer = undefined; void flush(); }, 320);
}
async function flush(): Promise<void> {
  if (!ready || saving || !changedSinceSave) return;
  saving = true;
  changedSinceSave = false;
  const sent = { ...state, pinned: [...state.pinned] };
  try {
    const saved = await request(sent);
    state = { ...state, revision: saved.revision };
    saveError = '';
    report('Настройки сохранены в папке .runtime проекта.');
  } catch (error) {
    saveError = error instanceof Error ? error.message : 'Ошибка записи настроек.';
    // Do not silently overwrite a conflicting edit from another browser tab.
    // The visible settings remain unchanged until explicit reload or retry.
    report('Не удалось сохранить настройки: ' + saveError);
  } finally {
    saving = false;
    if (changedSinceSave) scheduleSave();
  }
}
async function load(): Promise<void> {
  try {
    const remote = await request();
    if (!modifiedBeforeLoad) state = remote;
    else state = { ...state, revision: remote.revision };
    saveError = '';
  } catch (error) {
    saveError = error instanceof Error ? error.message : 'Настройки недоступны.';
    report('Настройки не загружены: ' + saveError);
  } finally {
    ready = true;
    apply();
    if (modifiedBeforeLoad) {
      changedSinceSave = true;
      scheduleSave();
    }
  }
}
function renderSettings(dialog: HTMLDialogElement): void {
  dialog.innerHTML = `
    <div class="personal-header"><div><span class="workspace-eyebrow">HAYUMERI / ПЕРСОНАЛИЗАЦИЯ</span><h2>Настройки интерфейса</h2>
    <p>Предпочтения сохраняются локально рядом с проектом и не отправляются в облако.</p></div>
    <button type="button" class="personal-close" data-close-settings aria-label="Закрыть настройки">×</button></div>
    <div class="settings-grid">
      <label class="settings-field"><span>Размер текста <output id="font-output">${Math.round(state.fontScale * 100)}%</output></span>
      <input type="range" min="90" max="130" step="5" value="${Math.round(state.fontScale * 100)}" data-setting="fontScale"></label>
      <label class="settings-field"><span>Ширина бокового меню <output id="sidebar-output">${state.sidebarWidth} px</output></span>
      <input type="range" min="206" max="340" step="2" value="${state.sidebarWidth}" data-setting="sidebarWidth"></label>
      <label class="settings-field"><span>Ширина редактора <output id="editor-output">${state.editorWidth} px</output></span>
      <input type="range" min="760" max="1600" step="40" value="${state.editorWidth}" data-setting="editorWidth"></label>
      <label class="settings-field"><span>Панель заметок <output id="note-output">${state.noteListPercent}%</output></span>
      <input type="range" min="25" max="52" step="1" value="${state.noteListPercent}" data-setting="noteListPercent"></label>
      <label class="settings-field"><span>Плотность элементов</span><select data-setting="density">
      <option value="comfortable" ${state.density === 'comfortable' ? 'selected' : ''}>Комфортная</option>
      <option value="compact" ${state.density === 'compact' ? 'selected' : ''}>Компактная</option></select></label>
      <label class="settings-check"><input type="checkbox" data-setting="effects" ${state.effects ? 'checked' : ''}>
      <span>Плавные переходы и декоративные эффекты</span></label>
      <label class="settings-check"><input type="checkbox" data-setting="sidebarCollapsed" ${state.sidebarCollapsed ? 'checked' : ''}>
      <span>Сворачивать боковое меню до иконок</span></label>
    </div>
    <div class="settings-bottom"><button type="button" class="action-secondary" data-reset-settings>Вернуть настройки по умолчанию</button>
    <button type="button" class="gold-button" data-retry-settings>Повторить сохранение</button></div>
    <p id="settings-status" role="status" aria-live="polite">${saveError ? 'Последняя ошибка: ' + htmlEscape(saveError) : 'Настройки сохраняются автоматически после изменения.'}</p>
    <div class="settings-help">Горячие клавиши: Ctrl+K — команды; Ctrl+, — настройки; Ctrl+B — боковое меню. 
    На узких экранах меню автоматически переходит в горизонтальный режим.</div>
  `;
}
function renderCommands(dialog: HTMLDialogElement, query: string): void {
  const commands = [
    ...Object.entries(routeTitles).map(([route, name]) => ({ title: 'Открыть: ' + name, key: route, kind: 'route' })),
    { title: 'Открыть настройки интерфейса', key: 'settings', kind: 'action' },
    { title: 'Показать обновления GitHub', key: 'updates', kind: 'action' },
    { title: 'Свернуть или развернуть меню', key: 'sidebar', kind: 'action' }
  ];
  const matched = commands.filter(item => item.title.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')));
  const results = dialog.querySelector<HTMLElement>('#command-results');
  if (!results) return;
  results.innerHTML = matched.length
    ? matched.map((item, index) => '<button type="button" class="command-item' + (index === 0 ? ' is-selected' : '') + '" data-command="' + item.key
      + '" data-kind="' + item.kind + '"><span>' + htmlEscape(item.title) + '</span><span aria-hidden="true">↵</span></button>').join('')
    : '<p class="command-empty">Раздел или команда не найдены. Поиск по содержимому заметок здесь не выполняется.</p>';
}
export function initPersonalizationUi(): void {
  if (initialized) return;
  initialized = true;
  const settings = document.createElement('dialog');
  settings.id = 'preferences-dialog';
  settings.className = 'personal-dialog';
  settings.setAttribute('aria-label', 'Настройки оформления Hayumeri');
  document.body.append(settings);
  const commands = document.createElement('dialog');
  commands.id = 'command-dialog';
  commands.className = 'personal-dialog command-dialog';
  commands.setAttribute('aria-label', 'Команды и переходы');
  commands.innerHTML = `<div class="command-header"><label for="command-query">Поиск раздела или команды</label>
    <button type="button" class="personal-close" data-close-commands aria-label="Закрыть поиск">×</button></div>
    <input id="command-query" type="search" autocomplete="off" placeholder="Раздел, настройка, обновление…" aria-controls="command-results">
    <div id="command-results" class="command-results"></div>
    <p class="command-hint">↑ ↓ — выбор · Enter — выполнить · Esc — закрыть</p>`;
  document.body.append(commands);

  const openSettings = (): void => {
    if (commands.open) commands.close();
    renderSettings(settings);
    if (!settings.open) settings.showModal();
    settings.querySelector<HTMLInputElement>('[data-setting="fontScale"]')?.focus();
  };
  const openCommands = (): void => {
    if (settings.open) settings.close();
    if (!commands.open) commands.showModal();
    const search = commands.querySelector<HTMLInputElement>('#command-query')!;
    search.value = '';
    renderCommands(commands, '');
    search.focus();
  };
  document.querySelector<HTMLButtonElement>('#settings-trigger')?.addEventListener('click', openSettings);
  document.querySelector<HTMLButtonElement>('#command-trigger')?.addEventListener('click', openCommands);
  document.querySelector<HTMLButtonElement>('#sidebar-toggle')?.addEventListener('click', () =>
    setPreferences({ sidebarCollapsed: !state.sidebarCollapsed }));

  settings.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLElement>('[data-close-settings], [data-reset-settings], [data-retry-settings]');
    if (!target) return;
    if (target.hasAttribute('data-close-settings')) settings.close();
    if (target.hasAttribute('data-reset-settings')) {
      if (!window.confirm('Вернуть оформление по умолчанию? Закреплённые разделы также будут сброшены.')) return;
      const fresh = defaults();
      setPreferences({
        sidebarCollapsed: fresh.sidebarCollapsed, sidebarWidth: fresh.sidebarWidth,
        noteListPercent: fresh.noteListPercent, editorWidth: fresh.editorWidth,
        fontScale: fresh.fontScale, density: fresh.density, effects: fresh.effects,
        pinned: fresh.pinned
      });
      renderSettings(settings);
    }
    if (target.hasAttribute('data-retry-settings')) {
      changedSinceSave = true;
      scheduleSave();
      report('Повторная попытка сохранения…');
    }
  });
  const settingsChanged = (event: Event): void => {
    const el = event.target as HTMLInputElement | HTMLSelectElement;
    const key = el.dataset.setting;
    if (!key) return;
    switch (key) {
      case 'fontScale': {
        const value = Number(el.value) / 100;
        if (value >= .9 && value <= 1.3) setPreferences({ fontScale: value });
        break;
      }
      case 'sidebarWidth': {
        const value = Number(el.value);
        if (Number.isInteger(value) && value >= 206 && value <= 340) setPreferences({ sidebarWidth: value });
        break;
      }
      case 'editorWidth': {
        const value = Number(el.value);
        if (Number.isInteger(value) && value >= 760 && value <= 1600) setPreferences({ editorWidth: value });
        break;
      }
      case 'noteListPercent': {
        const value = Number(el.value);
        if (Number.isInteger(value) && value >= 25 && value <= 52) setPreferences({ noteListPercent: value });
        break;
      }
      case 'density': if (el.value === 'comfortable' || el.value === 'compact') setPreferences({ density: el.value }); break;
      case 'effects': setPreferences({ effects: (el as HTMLInputElement).checked }); break;
      case 'sidebarCollapsed': setPreferences({ sidebarCollapsed: (el as HTMLInputElement).checked }); break;
    }
    const output = el.closest('label')?.querySelector('output');
    if (output) output.textContent = key === 'fontScale' ? Math.round(state.fontScale * 100) + '%' :
      key === 'noteListPercent' ? state.noteListPercent + '%' : el.value + ' px';
  };
  settings.addEventListener('input', event => {
    if ((event.target as HTMLElement).matches('input[type=range]')) settingsChanged(event);
  });
  settings.addEventListener('change', event => {
    if (!(event.target as HTMLElement).matches('input[type=range]')) settingsChanged(event);
  });

  const runCommand = (kind: string, key: string): void => {
    commands.close();
    if (kind === 'route' && key in routeTitles) location.hash = '#' + key;
    else if (key === 'settings') openSettings();
    else if (key === 'updates') document.querySelector<HTMLButtonElement>('#update-trigger')?.click();
    else if (key === 'sidebar') setPreferences({ sidebarCollapsed: !state.sidebarCollapsed });
  };
  commands.addEventListener('input', event => {
    if ((event.target as HTMLElement).id === 'command-query') {
      renderCommands(commands, (event.target as HTMLInputElement).value);
    }
  });
  commands.addEventListener('click', event => {
    const element = (event.target as Element).closest<HTMLElement>('[data-command],[data-close-commands]');
    if (!element) return;
    if (element.hasAttribute('data-close-commands')) { commands.close(); return; }
    runCommand(element.dataset.kind ?? '', element.dataset.command ?? '');
  });
  commands.addEventListener('keydown', event => {
    if (!['ArrowDown','ArrowUp','Enter'].includes(event.key)) return;
    const options = [...commands.querySelectorAll<HTMLButtonElement>('.command-item')];
    if (!options.length) return;
    const index = Math.max(0, options.findIndex(item => item.classList.contains('is-selected')));
    if (event.key === 'Enter') {
      event.preventDefault();
      const current = options[index];
      runCommand(current.dataset.kind ?? '', current.dataset.command ?? '');
      return;
    }
    event.preventDefault();
    options[index].classList.remove('is-selected');
    const next = (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
    options[next].classList.add('is-selected');
    options[next].scrollIntoView({ block: 'nearest' });
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing) return;
    const target = event.target as HTMLElement;
    const editable = target.matches('input, textarea, select, [contenteditable="true"]');
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      if (event.code === 'KeyK') { event.preventDefault(); openCommands(); }
      else if (event.code === 'Comma') { event.preventDefault(); openSettings(); }
      else if (event.code === 'KeyB' && !editable) {
        event.preventDefault(); setPreferences({ sidebarCollapsed: !state.sidebarCollapsed });
      }
    } else if (event.key === '/' && !editable && !settings.open && !commands.open) {
      event.preventDefault(); openCommands();
    }
  });
  window.addEventListener('hayumeri:toggle-pin', event => {
    const route = (event as CustomEvent<WorkspaceRoute>).detail;
    if (!(route in routeTitles)) return;
    const pinned = state.pinned.includes(route) ? state.pinned.filter(item => item !== route) : [...state.pinned, route];
    setPreferences({ pinned });
    report(state.pinned.includes(route) ? 'Раздел закреплён.' : 'Раздел откреплён.');
  });
  const resize = document.querySelector<HTMLElement>('#sidebar-resize');
  if (resize) {
    let startWidth = state.sidebarWidth;
    let dragging = false;
    resize.addEventListener('pointerdown', event => {
      if (event.button !== 0 || window.innerWidth <= 930 || state.sidebarCollapsed) return;
      dragging = true;
      startWidth = state.sidebarWidth;
      resize.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    resize.addEventListener('pointermove', event => {
      if (!dragging) return;
      const aside = document.querySelector<HTMLElement>('.app-sidebar')!;
      const left = aside.getBoundingClientRect().left;
      const width = Math.round(Math.max(206, Math.min(340, event.clientX - left)));
      setPreferences({ sidebarWidth: width }, false);
    });
    const finish = (): void => {
      if (!dragging) return;
      dragging = false;
      if (state.sidebarWidth !== startWidth) setPreferences({ sidebarWidth: state.sidebarWidth });
    };
    resize.addEventListener('pointerup', finish);
    resize.addEventListener('pointercancel', finish);
    resize.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      setPreferences({ sidebarWidth: Math.max(206, Math.min(340, state.sidebarWidth + (event.key === 'ArrowRight' ? 10 : -10))) });
    });
  }
  apply();
  void load();
}
