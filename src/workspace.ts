import { getPreferences, setPreferences } from './personalization';
type Note = { id: string; title: string; content: string; updatedAt: string };
type Task = { id: string; text: string; done: boolean; createdAt: string };
type WorkspaceData = { schema: 1; revision: number; notes: Note[]; tasks: Task[] };
type Route = 'home' | 'notes' | 'tasks' | 'knowledge' | 'memory' | 'graph' | 'agents' | 'chat' | 'disk' | 'system';

const routes: Record<Route, { title: string; sub: string; icon: string }> = {
  home: { title: 'Главная', sub: 'Обзор среды', icon: '⌂' },
  notes: { title: 'Заметки', sub: 'Локальный редактор', icon: '▤' },
  tasks: { title: 'Задачи', sub: 'Личные дела', icon: '✓' },
  knowledge: { title: 'Знания', sub: 'Документы и источники', icon: '▧' },
  memory: { title: 'Память', sub: 'Факты и контекст', icon: '◇' },
  graph: { title: 'Граф связей', sub: 'Карта отношений', icon: '⌘' },
  agents: { title: 'Агенты', sub: 'Помощники и сценарии', icon: '✧' },
  chat: { title: 'Чат', sub: 'Диалоги с ИИ', icon: '◌' },
  disk: { title: 'Диск', sub: 'Файлы проекта', icon: '▣' },
  system: { title: 'Система', sub: 'Инфраструктура', icon: '⚙' }
};
const routeKeys = Object.keys(routes) as Route[];
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const blank = (): WorkspaceData => ({ schema: 1, revision: 0, notes: [], tasks: [] });
function isRoute(value: string): value is Route { return Object.prototype.hasOwnProperty.call(routes, value); }
function currentRoute(): Route {
  const hash = location.hash.replace(/^#/, '');
  return isRoute(hash) ? hash : 'home';
}
function formatDate(value: string): string {
  try { return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value)); }
  catch { return '—'; }
}
async function workspaceRequest(body?: WorkspaceData): Promise<WorkspaceData> {
  const response = await fetch('/api/workspace/data', {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', 'X-Hayumeri-Action': '1' } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const message = typeof result === 'object' && result && 'error' in result
      && typeof result.error === 'string' ? result.error : 'Ошибка локального хранилища.';
    throw new Error(message);
  }
  return result as WorkspaceData;
}

export function initWorkspaceUi(): void {
  const homeView = document.querySelector<HTMLElement>('#home-view')!;
  const view = document.querySelector<HTMLElement>('#workspace-view')!;
  const navigation = document.querySelector<HTMLElement>('#workspace-navigation')!;
  const liveStatus = document.querySelector<HTMLElement>('#workspace-live-status')!;
  let route: Route = 'home';
  let data = blank();
  let loaded = false;
  let loading = false;
  let saving = false;
  let selectedNote: string | null = null;
  let dirty = false;
  let noteSearch = '';
  let taskFilter: 'all' | 'open' | 'done' = 'all';
  let errorMessage = '';
  type SemanticHit = {sourceId:string;title:string;preview:string;score:number;updatedAt:string};
  let semanticStatus: {state:string;message:string;indexed:number;total:number;model:string}|null = null;
  let semanticQuery = '';
  let semanticHits: SemanticHit[] = [];
  let semanticFeedback = '';
  let semanticBusy = false;


  function announce(message: string): void { liveStatus.textContent = message; }

  async function ensureLoaded(): Promise<void> {
    if (loaded || loading) return;
    loading = true;
    render();
    try {
      data = await workspaceRequest();
      loaded = true;
      errorMessage = '';
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Не удалось прочитать данные.';
      announce('Ошибка загрузки: ' + errorMessage);
    } finally { loading = false; render(); }
  }
  async function persist(next: WorkspaceData, success: string): Promise<boolean> {
    if (!loaded || saving) return false;
    saving = true;
    errorMessage = '';
    try {
      data = await workspaceRequest(next);
      dirty = false;
      announce(success);
      return true;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Не удалось сохранить изменения.';
      announce('Ошибка сохранения: ' + errorMessage);
      return false;
    } finally {
      saving = false;
      // Do not rebuild the editor after a failed write: the unsaved text
      // must stay available for retry or manual copying.
      if (!errorMessage) render();
    }
  }
  function renderNavigation(): void {
    const pinned = getPreferences().pinned;
    const ordered = [...routeKeys].sort((a, b) => Number(pinned.includes(b)) - Number(pinned.includes(a)));
    navigation.innerHTML = ordered.map(key => {
      const item = routes[key];
      const active = route === key;
      const fixed = pinned.includes(key);
      const badge = key === 'notes' || key === 'tasks' ? '<span class="nav-bullet" title="Работает локально"></span>' : '';
      return '<div class="workspace-nav-row"><a class="workspace-nav-item' + (active ? ' is-active' : '') + '" href="#'
        + key + '" data-workspace="' + key + '" title="' + escapeHtml(item.title) + '"' + (active ? ' aria-current="page"' : '') + '>'
        + '<span class="nav-icon" aria-hidden="true">' + item.icon + '</span>'
        + '<span class="nav-name">' + item.title + '</span>' + badge + '</a>'
        + '<button class="workspace-pin' + (fixed ? ' is-pinned' : '') + '" type="button" data-pin-route="' + key
        + '" aria-label="' + (fixed ? 'Открепить: ' : 'Закрепить: ') + item.title
        + '" aria-pressed="' + fixed + '" title="' + (fixed ? 'Открепить раздел' : 'Закрепить раздел') + '">'
        + (fixed ? '★' : '☆') + '</button></div>';
    }).join('');
  }

  function sectionHeader(title: string, lead: string, eyebrow: string): string {
    return '<header class="workspace-heading"><div class="workspace-eyebrow">' + eyebrow + '</div>'
      + '<h1 tabindex="-1" id="workspace-title">' + title + '</h1><p>' + lead + '</p></header>';
  }
  function errorBar(): string {
    if (!errorMessage) return '';
    return '<div class="workspace-error" role="alert">' + escapeHtml(errorMessage)
      + ' <button type="button" data-action="retry">Повторить загрузку</button></div>';
  }
  function renderNotePanel(): string {
    const notes = [...data.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const filtered = notes.filter(note => (note.title + ' ' + note.content).toLocaleLowerCase('ru').includes(noteSearch.toLocaleLowerCase('ru')));
    const selected = data.notes.find(note => note.id === selectedNote);
    return sectionHeader('Заметки', 'Личные записи сохраняются в папке .runtime проекта Hayumeri. Не отправляются в GitHub или облако.', 'РАБОЧЕЕ ПРОСТРАНСТВО / 01')
      + '<div class="workspace-banner">Локальные данные · ' + notes.length
      + ' записей · Автоматического сохранения нет — нажимайте «Сохранить».</div>'
      + '<div class="note-layout"><div class="notes-sidebar">'
      + '<div class="notes-actions"><button type="button" class="gold-button" data-action="new-note">+ Новая заметка</button></div>'
      + '<label class="field-label" for="notes-search">Поиск заметок</label>'
      + '<input class="workspace-input" id="notes-search" type="search" placeholder="Найти по тексту..." value="' + escapeHtml(noteSearch) + '">'
      + '<div class="notes-list" aria-label="Сохранённые заметки">'
      + (filtered.length ? filtered.map(note => '<button type="button" class="note-list-item' + (note.id === selectedNote ? ' selected' : '')
        + '" data-action="select-note" data-id="' + escapeHtml(note.id) + '"><strong>'
        + escapeHtml(note.title || 'Без названия') + '</strong><span>' + formatDate(note.updatedAt) + '</span></button>').join('')
        : '<div class="empty-list">Заметок пока нет либо поиск не дал результатов.</div>')
      + '</div></div><div class="note-resize" role="separator" tabindex="0" aria-label="Изменить ширину списка заметок" aria-orientation="vertical" aria-valuemin="25" aria-valuemax="52" aria-valuenow="' + getPreferences().noteListPercent + '" title="Перетащить или использовать стрелки"></div><div class="note-editor">'
      + '<div class="editor-caption">РЕДАКТОР / ' + (selected ? 'СОХРАНЁННАЯ ЗАПИСЬ' : 'НОВАЯ ЗАПИСЬ') + '</div>'
      + '<label class="field-label" for="note-title">Название</label>'
      + '<input class="workspace-input" id="note-title" maxlength="200" placeholder="Название заметки" value="' + escapeHtml(selected?.title ?? '') + '">'
      + '<label class="field-label" for="note-body">Содержание</label>'
      + '<textarea class="workspace-textarea" id="note-body" maxlength="100000" placeholder="Начните писать...">' + escapeHtml(selected?.content ?? '') + '</textarea>'
      + '<div class="editor-footer"><span class="save-state" id="save-state">Сохранение по кнопке</span>'
      + '<div class="editor-buttons">'
      + (selected ? '<button type="button" class="danger-button" data-action="delete-note">Удалить</button>' : '')
      + '<button type="button" class="gold-button" data-action="save-note">Сохранить</button></div></div>'
      + '</div></div>';
  }
  function renderTasks(): string {
    const visible = data.tasks.filter(task => taskFilter === 'all' || (taskFilter === 'done') === task.done);
    const remaining = data.tasks.filter(task => !task.done).length;
    return sectionHeader('Задачи', 'Простой локальный список дел. Записи хранятся в .runtime и защищены резервной копией предыдущей версии.', 'РАБОЧЕЕ ПРОСТРАНСТВО / 02')
      + '<div class="workspace-banner">' + remaining + ' активных · ' + data.tasks.length + ' всего · Данные сохраняются после каждого действия</div>'
      + '<form id="task-create" class="task-form"><label class="field-label" for="new-task-text">Новая задача</label>'
      + '<div class="task-add-row"><input class="workspace-input" id="new-task-text" name="text" maxlength="500" required placeholder="Что нужно сделать?">'
      + '<button class="gold-button" type="submit">Добавить</button></div></form>'
      + '<div class="task-toolbar" role="group" aria-label="Фильтр задач">'
      + (['all', 'open', 'done'] as const).map(key =>
        '<button class="filter-button' + (taskFilter === key ? ' selected' : '') + '" data-filter="' + key
        + '" type="button" aria-pressed="' + (taskFilter === key) + '">'
        + ({ all: 'Все', open: 'Активные', done: 'Завершённые' })[key] + '</button>').join('')
      + '</div><div class="task-list">'
      + (visible.length ? visible.map(task => '<div class="task-item' + (task.done ? ' is-done' : '')
        + '"><label class="task-check"><input type="checkbox" data-action="toggle-task" data-id="' + escapeHtml(task.id)
        + '"' + (task.done ? ' checked' : '') + '><span>' + escapeHtml(task.text) + '</span></label>'
        + '<button class="task-delete" data-action="delete-task" data-id="' + escapeHtml(task.id)
        + '" type="button" aria-label="Удалить задачу: ' + escapeHtml(task.text) + '">×</button></div>').join('')
        : '<div class="workspace-empty">В этом списке задач пока нет.</div>')
      + '</div>';
  }
  type NoSqlView = {
    state: string; profile: string; message: string;
    running: string[]; diskFreeGiB: number; updatedAt: string | null;
  };
  let nosqlState: NoSqlView | null = null;
  const noSqlNames = [
    ['mongodb', 'MongoDB', 'Документы'],
    ['redis', 'Redis', 'Быстрые данные'],
    ['neo4j', 'Neo4j', 'Граф связей'],
    ['qdrant', 'Qdrant', 'Векторная база']
  ] as const;
  async function refreshNoSql(): Promise<void> {
    if (route !== 'system') return;
    try {
      const response = await fetch('/api/nosql/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object') throw new Error('Некорректный статус.');
      const item = result as Record<string, unknown>;
      nosqlState = {
        state: typeof item.state === 'string' ? item.state : 'error',
        profile: item.profile === 'growth' ? 'growth' : 'balanced',
        message: typeof item.message === 'string' ? item.message : 'Состояние неизвестно.',
        running: Array.isArray(item.running) ? item.running.filter((v): v is string => typeof v === 'string') : [],
        diskFreeGiB: typeof item.diskFreeGiB === 'number' ? item.diskFreeGiB : -1,
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : null
      };
    } catch {
      nosqlState = {
        state: 'error', profile: 'balanced',
        message: 'Не удалось получить состояние NoSQL. Локальный сайт работает отдельно от Docker.',
        running: [], diskFreeGiB: -1, updatedAt: null
      };
    }
    if (route === 'system') render();
  }
  function renderSystem(): string {
    const item = nosqlState;
    const running = item?.running ?? [];
    const state = item?.state ?? 'pending';
    const good = state === 'running' && running.length === 4;
    const heading = good ? '4 контейнера запущены' : state === 'pending' || state === 'starting' || state === 'docker-starting'
      ? 'Автоматическая подготовка' : 'Требуется внимание';
    return sectionHeader('Система', 'Четыре NoSQL-базы управляются автоматически после запуска Hayumeri. Состояние Docker и ресурсов отображается без вымышленных показателей.', 'ИНФРАСТРУКТУРА / АВТОПИЛОТ')
      + '<section class="system-note nosql-panel" aria-label="Автоматическое управление NoSQL">'
      + '<span class="workspace-eyebrow">NO-SQL / АВТОМАТИЧЕСКИЙ РЕЖИМ</span>'
      + '<h2>' + heading + '</h2>'
      + '<p role="status" aria-live="polite">' + escapeHtml(item?.message ?? 'Получение сведений о Docker и базах…') + '</p>'
      + '<div class="nosql-metadata"><span>Режим памяти: <strong>' + escapeHtml(item?.profile ?? 'определяется') + '</strong></span>'
      + '<span>Диск проекта: <strong>' + (item && item.diskFreeGiB >= 0 ? item.diskFreeGiB.toFixed(1) + ' ГиБ свободно' : 'не измерен') + '</strong></span>'
      + '<span>Проверка: <strong>' + (item?.updatedAt ? escapeHtml(formatDate(item.updatedAt)) : 'ожидается') + '</strong></span></div>'
      + '<div class="nosql-service-grid">' + noSqlNames.map(([key, name, purpose]) =>
        '<div class="nosql-service"><span class="nosql-service-dot' + (running.includes(key) ? ' active' : '') + '" aria-hidden="true"></span>'
        + '<div><strong>' + name + '</strong><small>' + purpose + '</small></div>'
        + '<span class="nosql-service-label">' + (running.includes(key) ? 'Контейнер запущен' : 'Не подтверждён') + '</span></div>'
      ).join('') + '</div>'
      + '<p class="nosql-disclaimer">Статус «Контейнер запущен» не означает, что авторизация и запросы уже проверены. На ноутбуке с 16 ГБ RAM применяется экономный профиль, увеличение памяти допускается только при достаточном запасе.</p>'
      + '<button type="button" class="gold-button" data-action="open-update">Обновления GitHub</button>'
      + '</section>';
  }
  async function refreshSemanticStatus(): Promise<void> {
    if(route!=='memory')return;
    try {
      const response=await fetch('/api/memory/status',{cache:'no-store'});
      if(!response.ok)throw new Error('Статус недоступен.');
      const result: unknown=await response.json();
      const item=result as {state:string;message:string;indexed:number;total:number;model:string};
      semanticStatus=item;
    }catch{semanticStatus={state:'error',message:'Не удалось получить состояние смыслового индекса.',indexed:0,total:0,model:'не определена'};}
    if(route==='memory')render();
  }
  function renderSemanticMemory(): string {
    const item=semanticStatus;
    const statusText=item?.message??'Проверка Ollama, Qdrant и индекса заметок…';
    const results=semanticHits.map(hit=>
      '<article class="semantic-result"><div class="semantic-result-head"><strong>'+escapeHtml(hit.title||'Без названия')
      +'</strong><span>Сходство '+Math.round(Math.max(0,Math.min(1,hit.score))*100)+'%</span></div>'
      +'<p>'+escapeHtml(hit.preview)+'</p>'
      +'<div class="semantic-result-foot"><small>Источник: заметка · '+escapeHtml(formatDate(hit.updatedAt))+'</small>'
      +'<button type="button" class="gold-button" data-action="open-memory-note" data-id="'+escapeHtml(hit.sourceId)+'">Открыть источник</button></div></article>'
    ).join('');
    return sectionHeader('Векторная память', 'Смысловой поиск среди сохранённых заметок. Результаты проверяются по исходным записям; документы и разговоры пока не подключены.', 'ПАМЯТЬ / СЕМАНТИЧЕСКИЙ ПОИСК')
      +'<section class="semantic-panel"><span class="workspace-eyebrow">ЛОКАЛЬНАЯ МОДЕЛЬ / QDRANT</span>'
      +'<h2>'+escapeHtml(item?.state==='ready'?'Индекс заметок доступен':'Подготовка смыслового индекса')+'</h2>'
      +'<p role="status">'+escapeHtml(statusText)+'</p>'
      +'<div class="semantic-stats"><span>Индексировано заметок: <strong>'+Math.max(0,item?.indexed??0)+'</strong></span>'
      +'<span>Всего заметок: <strong>'+Math.max(0,item?.total??0)+'</strong></span>'
      +'<span>Модель: <strong>'+escapeHtml(item?.model??'embeddinggemma')+'</strong></span></div>'
      +'<form id="semantic-search" class="semantic-form"><label class="field-label" for="semantic-query">Поиск по смыслу</label>'
      +'<div class="task-add-row"><input class="workspace-input" id="semantic-query" maxlength="500" required'
      +' placeholder="О чём я писал по этой теме?" value="'+escapeHtml(semanticQuery)+'">'
      +'<button type="submit" class="gold-button"'+(semanticBusy?' disabled':'')+'>Найти воспоминания</button></div></form>'
      +'<p class="semantic-notice">Локальные заметки остаются в .runtime. При первой настройке Ollama может автоматически загрузить модель через интернет; текст в облачные ИИ-сервисы не отправляется.</p>'
      +'<div id="semantic-results" class="semantic-results" aria-live="polite">'
      +(semanticFeedback?'<p class="workspace-banner">'+escapeHtml(semanticFeedback)+'</p>':'')
      +(results||(!semanticFeedback?'<div class="workspace-empty">Введите запрос, чтобы найти смысловые связи среди заметок.</div>':''))
      +'</div></section>';
  }
  function renderFuture(): string {
    if (route === 'system') return renderSystem();
    if (route === 'memory') return renderSemanticMemory();
    const descriptions: Record<Exclude<Route,'home'|'notes'|'tasks'>, { lead: string; details: string[] }> = {
      knowledge: { lead: 'Библиотека документов, редактор и полнотекстовый поиск.', details: ['Дерево папок и файлов','Просмотр источников','Редактор документов'] },
      memory: { lead: 'Долговременные факты с проверяемыми источниками.', details: ['Хронология памяти','Источники и точность','Связь с разговорами'] },
      graph: { lead: 'Визуальная карта знаний и связей между сущностями.', details: ['Узлы и отношения','Фильтрация графа','Объяснение связей'] },
      agents: { lead: 'Рабочее пространство для создания и контроля ИИ-агентов.', details: ['Создание агентов','Разрешения и инструменты','Журналы действий'] },
      chat: { lead: 'Диалоги с подключаемыми ИИ-моделями.', details: ['Подключение моделей','История разговоров','Работа с контекстом'] },
      disk: { lead: 'Постоянное хранилище пользовательских файлов.', details: ['Загрузка и просмотр','Папки и метаданные','Резервное копирование'] },
      system: { lead: 'Локальная инфраструктура Hayumeri и её обслуживание.', details: ['Обновления GitHub','MongoDB · Redis · Neo4j · Qdrant','Журналы запуска'] }
    };
    const item = descriptions[route as keyof typeof descriptions];
    return sectionHeader(routes[route].title, item.lead, 'ПРОСТРАНСТВО / ' + routes[route].sub.toUpperCase())
      + '<div class="future-status"><span class="future-icon" aria-hidden="true">✧</span><div>'
      + '<span class="future-kicker">МОДУЛЬ НЕ ПОДКЛЮЧЁН</span>'
      + '<h2>Пространство подготовлено к развитию</h2>'
      + '<p>Это интерфейс будущего раздела. Рабочий сервис, данные и действия здесь пока не подключены. Фиктивные результаты не показываются.</p>'
      + '</div></div>'
      + '<div class="future-grid">' + item.details.map((detail, index) =>
        '<div class="future-tile"><span>0' + (index + 1) + '</span><strong>' + escapeHtml(detail)
        + '</strong><small>Запланировано</small></div>').join('') + '</div>';
  }
  function render(): void {
    if (route === 'home') return;
    if ((route === 'notes' || route === 'tasks') && !loaded) {
      view.innerHTML = sectionHeader(routes[route].title, 'Подключение к локальному хранилищу…', 'РАБОЧЕЕ ПРОСТРАНСТВО')
        + errorBar()
        + (loading ? '<div class="workspace-loading" role="status">Загрузка записей…</div>'
          : '<button type="button" class="gold-button" data-action="retry">Повторить загрузку</button>');
      return;
    }
    view.innerHTML = errorBar() + (route === 'notes' ? renderNotePanel() : route === 'tasks' ? renderTasks() : renderFuture());
  }
  function navigate(next: Route): void {
    if (route !== next && dirty && !window.confirm('Заметка не сохранена. Покинуть редактор без сохранения?')) {
      if (location.hash.slice(1) !== route) history.replaceState(null, '', '#' + route);
      return;
    }
    dirty = false;
    route = next;
    homeView.hidden = next !== 'home';
    view.hidden = next === 'home';
    renderNavigation();
    render();
    if (next === 'notes' || next === 'tasks') void ensureLoaded();
    if (next === 'system') void refreshNoSql();
    if (next === 'memory') void refreshSemanticStatus();
    if (next === 'home' && (location.hash === '#foundation' || location.hash === '#platform')) {
      requestAnimationFrame(() => document.querySelector(location.hash)?.scrollIntoView());
    } else {
      window.scrollTo(0, 0);
    }
  }
  function requestRoute(): void { navigate(currentRoute()); }

  navigation.addEventListener('click', event => {
    const pin = (event.target as Element).closest<HTMLButtonElement>('[data-pin-route]');
    if (pin) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('hayumeri:toggle-pin', { detail: pin.dataset.pinRoute }));
      return;
    }
    const link = (event.target as Element).closest<HTMLAnchorElement>('[data-workspace]');
    if (link && link.dataset.workspace === route) event.preventDefault();
  });
  window.addEventListener('hayumeri:preferences-change', renderNavigation);
  view.addEventListener('pointerdown', event => {
    const handle = (event.target as Element).closest<HTMLElement>('.note-resize');
    if (!handle || event.button !== 0 || window.innerWidth <= 760) return;
    const layout = handle.closest<HTMLElement>('.note-layout')!;
    const frame = layout.getBoundingClientRect();
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent): void => {
      const percent = Math.max(25, Math.min(52, Math.round(100 * (next.clientX - frame.left) / frame.width)));
      setPreferences({ noteListPercent: percent }, false);
      handle.setAttribute('aria-valuenow', String(percent));
    };
    const finish = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      setPreferences({ noteListPercent: getPreferences().noteListPercent });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    event.preventDefault();
  });
  view.addEventListener('keydown', event => {
    const handle = (event.target as Element).closest<HTMLElement>('.note-resize');
    if (handle && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      const next = Math.max(25, Math.min(52, getPreferences().noteListPercent + (event.key === 'ArrowRight' ? 2 : -2)));
      setPreferences({ noteListPercent: next });
      handle.setAttribute('aria-valuenow', String(next));
    }
  });
  document.addEventListener('keydown', event => {
    if (route === 'notes' && (event.ctrlKey || event.metaKey) && event.code === 'KeyS' && !event.altKey) {
      event.preventDefault();
      view.querySelector<HTMLButtonElement>('[data-action="save-note"]')?.click();
    }
  });
  window.addEventListener('hashchange', requestRoute);
  window.addEventListener('beforeunload', event => {
    if (dirty) { event.preventDefault(); event.returnValue = ''; }
  });
  view.addEventListener('input', event => {
    const element = event.target as HTMLElement;
    if (element.id === 'note-title' || element.id === 'note-body') {
      dirty = true;
      const status = view.querySelector<HTMLElement>('#save-state');
      if (status) status.textContent = 'Есть несохранённые изменения';
    }
    if (element.id === 'notes-search') {
      noteSearch = (element as HTMLInputElement).value;
      // Filtering must never destroy an unsaved note draft.
      const titleDraft = view.querySelector<HTMLInputElement>('#note-title')?.value ?? '';
      const bodyDraft = view.querySelector<HTMLTextAreaElement>('#note-body')?.value ?? '';
      const searchField = element as HTMLInputElement;
      const cursorStart = searchField.selectionStart;
      const cursorEnd = searchField.selectionEnd;
      render();
      const nextTitle = view.querySelector<HTMLInputElement>('#note-title');
      const nextBody = view.querySelector<HTMLTextAreaElement>('#note-body');
      if (nextTitle) nextTitle.value = titleDraft;
      if (nextBody) nextBody.value = bodyDraft;
      const nextSearch = view.querySelector<HTMLInputElement>('#notes-search');
      nextSearch?.focus();
      if (cursorStart !== null && cursorEnd !== null) nextSearch?.setSelectionRange(cursorStart, cursorEnd);
    }
  });
  view.addEventListener('submit', event => {
    const form = event.target as HTMLFormElement;
    if (form.id === 'semantic-search') {
      event.preventDefault();
      if(semanticBusy)return;
      const query=form.querySelector<HTMLInputElement>('#semantic-query')?.value.trim()??'';
      if(!query)return;
      semanticBusy=true;semanticQuery=query;semanticHits=[];semanticFeedback='Идёт поиск в Qdrant…';render();
      void (async()=>{
        try{
          const response=await fetch('/api/memory/search',{
            method:'POST',headers:{'Content-Type':'application/json','X-Hayumeri-Action':'1'},
            body:JSON.stringify({query}),cache:'no-store'
          });
          const result:unknown=await response.json();
          if(!response.ok){
            const problem=result as {error?:string};
            throw new Error(problem.error??'Поиск временно недоступен.');
          }
          const payload=result as {hits:SemanticHit[]};
          semanticHits=Array.isArray(payload.hits)?payload.hits:[];
          semanticFeedback=semanticHits.length?'Показаны результаты, сопоставленные с актуальными исходными заметками.':'Совпадений среди проиндексированных заметок не найдено.';
        }catch(error){semanticFeedback=error instanceof Error?error.message:'Поиск не удался.';}
        finally{semanticBusy=false;if(route==='memory')render();}
      })();
      return;
    }
    if (form.id !== 'task-create') return;
    event.preventDefault();
    const field = form.querySelector<HTMLInputElement>('#new-task-text');
    const text = field?.value.trim() ?? '';
    if (!text || !loaded || saving || data.tasks.length >= 2000) return;
    const task: Task = { id: crypto.randomUUID(), text, done: false, createdAt: new Date().toISOString() };
    void persist({ ...data, tasks: [task, ...data.tasks] }, 'Задача добавлена.');
  });
  view.addEventListener('change', event => {
    const element = event.target as HTMLInputElement;
    if (element.dataset.action !== 'toggle-task' || !loaded || saving) return;
    const tasks = data.tasks.map(task => task.id === element.dataset.id ? { ...task, done: element.checked } : task);
    void persist({ ...data, tasks }, 'Задача обновлена.');
  });
  view.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-action], [data-filter]');
    if (!button || button.disabled) return;
    if (button.dataset.filter) {
      taskFilter = button.dataset.filter as typeof taskFilter;
      render();
      return;
    }
    const action = button.dataset.action;
    if (action === 'open-update') { document.querySelector<HTMLButtonElement>('#update-trigger')?.click(); return; }
    if (action === 'open-memory-note') {
      selectedNote=button.dataset.id??null;
      location.hash='#notes';
      return;
    }
    if (action === 'retry') { loaded = false; errorMessage = ''; void ensureLoaded(); return; }
    if (!loaded || saving) return;
    if (action === 'new-note' || action === 'select-note') {
      if (dirty && !window.confirm('Заметка не сохранена. Отменить изменения?')) return;
      selectedNote = action === 'select-note' ? button.dataset.id ?? null : null;
      dirty = false;
      render();
      if (action === 'new-note') view.querySelector<HTMLInputElement>('#note-title')?.focus();
      return;
    }
    if (action === 'save-note') {
      const title = view.querySelector<HTMLInputElement>('#note-title')?.value.trim() ?? '';
      const body = view.querySelector<HTMLTextAreaElement>('#note-body')?.value ?? '';
      if (!title && !body.trim()) { announce('Введите название или содержание заметки.'); return; }
      if (!selectedNote && data.notes.length >= 500) { announce('Достигнут лимит 500 заметок.'); return; }
      const id = selectedNote ?? crypto.randomUUID();
      const updated: Note = { id, title: title || 'Без названия', content: body, updatedAt: new Date().toISOString() };
      const notes = [updated, ...data.notes.filter(note => note.id !== id)];
      void persist({ ...data, notes }, 'Заметка сохранена.').then(success => { if (success) { selectedNote = id; render(); } });
      return;
    }
    if (action === 'delete-note') {
      if (!selectedNote || !window.confirm('Удалить эту заметку? Действие нельзя отменить.')) return;
      const notes = data.notes.filter(note => note.id !== selectedNote);
      void persist({ ...data, notes }, 'Заметка удалена.').then(success => { if (success) { selectedNote = null; render(); } });
      return;
    }
    if (action === 'delete-task') {
      if (!window.confirm('Удалить задачу?')) return;
      const tasks = data.tasks.filter(task => task.id !== button.dataset.id);
      void persist({ ...data, tasks }, 'Задача удалена.');
    }
  });
  window.setInterval(() => { if (route === 'system') void refreshNoSql(); }, 30000);
  window.setInterval(() => { if (route === 'memory' && !semanticBusy) void refreshSemanticStatus(); }, 30000);
  requestRoute();
}
