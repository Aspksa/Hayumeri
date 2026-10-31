type UpdateInfo = {
  current: string;
  version: string;
  canApply: boolean;
  hasUpdate: boolean;
  note?: string;
  latest?: { sha: string; message: string; url: string } | null;
};

export function initUpdateUi(): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'update-dialog';
  dialog.setAttribute('aria-label', 'Обновление Hayumeri');
  dialog.innerHTML = [
    '<div class="update-panel">',
    '<div class="update-heading">',
    '<span class="update-symbol" aria-hidden="true">↻</span>',
    '<div class="update-heading-text"><h2>Обновления Hayumeri</h2><p>Проверка проекта в GitHub</p></div>',
    '<button class="update-close" type="button" aria-label="Закрыть">×</button>',
    '</div>',
    '<div class="update-versions">',
    '<div><small>Установленная версия</small><strong id="update-current">—</strong></div>',
    '<div><small>GitHub · main</small><strong id="update-latest">Не проверено</strong></div>',
    '</div>',
    '<p class="update-status" id="update-status" role="status" aria-live="polite">Проверка доступна по кнопке ниже.</p>',
    '<div class="update-changes" id="update-changes" hidden>',
    '<strong>Последнее изменение</strong><p id="update-description"></p>',
    '<a id="update-commit" href="https://github.com/Aspksa/Hayumeri" target="_blank" rel="noopener noreferrer">Посмотреть коммит в GitHub</a>',
    '</div>',
    '<div class="update-note">Перед установкой создаётся резервная копия. Настройки, API-ключи, документы и данные NoSQL сохраняются. При сбое новой версии выполняется откат.</div>',
    '<div class="update-controls">',
    '<button class="update-check" id="update-check" type="button">Проверить GitHub</button>',
    '<button class="update-install" id="update-install" type="button" disabled>Установить обновление</button>',
    '</div></div>'
  ].join('');
  document.body.append(dialog);

  const trigger = document.querySelector<HTMLButtonElement>('#update-trigger')!;
  const indicator = document.querySelector<HTMLSpanElement>('#update-indicator')!;
  const status = dialog.querySelector<HTMLElement>('#update-status')!;
  const current = dialog.querySelector<HTMLElement>('#update-current')!;
  const newest = dialog.querySelector<HTMLElement>('#update-latest')!;
  const description = dialog.querySelector<HTMLElement>('#update-description')!;
  const changes = dialog.querySelector<HTMLElement>('#update-changes')!;
  const commitLink = dialog.querySelector<HTMLAnchorElement>('#update-commit')!;
  const checkButton = dialog.querySelector<HTMLButtonElement>('#update-check')!;
  const installButton = dialog.querySelector<HTMLButtonElement>('#update-install')!;
  const closeButton = dialog.querySelector<HTMLButtonElement>('.update-close')!;

  let checked: UpdateInfo | null = null;
  let updateBusy = false;

  function setStatus(message: string, kind: 'neutral' | 'success' | 'warning' = 'neutral'): void {
    status.textContent = message;
    status.dataset.kind = kind;
  }
  function render(info: UpdateInfo): void {
    checked = info;
    current.textContent = 'v' + info.version + (info.current ? ' · ' + info.current.slice(0, 8) : '');
    newest.textContent = info.latest ? info.latest.sha.slice(0, 8) : 'Не проверено';
    changes.hidden = !info.latest;
    if (info.latest) {
      description.textContent = info.latest.message || 'Изменения опубликованы в GitHub.';
      commitLink.href = info.latest.url;
    }
    indicator.hidden = !info.hasUpdate;
    installButton.disabled = updateBusy || !info.hasUpdate || !info.canApply;
    if (info.hasUpdate) {
      setStatus(info.canApply
        ? 'Доступна новая версия. Установка перезапустит Hayumeri.'
        : (info.note || 'Доступна новая версия, но установка через сайт сейчас недоступна.'), 'warning');
    } else if (info.latest) {
      setStatus('Установлена актуальная версия.', 'success');
    } else {
      setStatus(info.note || 'Нажмите «Проверить GitHub».');
    }
  }
  async function request(path: string, body?: object): Promise<UpdateInfo & { error?: string }> {
    const response = await fetch('/api/update/' + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'X-Hayumeri-Action': '1' } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    });
    const result = await response.json() as UpdateInfo & { error?: string };
    if (!response.ok) throw new Error(result.error || 'Сервис обновления вернул ошибку.');
    return result;
  }
  async function check(): Promise<void> {
    if (updateBusy) return;
    updateBusy = true;
    checkButton.disabled = true;
    installButton.disabled = true;
    setStatus('Подключение к GitHub и проверка новой версии…');
    try { render(await request('check', {})); }
    catch (error) { setStatus(error instanceof Error ? error.message : 'Не удалось проверить обновление.', 'warning'); }
    finally {
      updateBusy = false;
      checkButton.disabled = false;
      if (checked?.hasUpdate && checked.canApply) installButton.disabled = false;
    }
  }
  trigger.addEventListener('click', async () => {
    dialog.showModal();
    try {
      const info = await request('status');
      render(info);
      if (!info.latest) void check();
    } catch { setStatus('Сервис обновления доступен при запуске через Hayumeri.bat.', 'warning'); }
  });
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  checkButton.addEventListener('click', () => void check());

  installButton.addEventListener('click', async () => {
    if (!checked?.latest || !checked.canApply || updateBusy) return;
    if (!window.confirm('Установить новую версию Hayumeri? Будет создана резервная копия и выполнен перезапуск.')) return;
    updateBusy = true;
    installButton.disabled = true;
    checkButton.disabled = true;
    setStatus('Запускается установка. Сайт временно отключится и откроется повторно после проверки.');
    try {
      await request('apply', { sha: checked.latest.sha });
      setStatus('Установка запущена. Не закрывайте консоль до завершения. Если возникнет ошибка, программа восстановит резервную копию.');
    } catch (error) {
      updateBusy = false;
      checkButton.disabled = false;
      installButton.disabled = false;
      setStatus(error instanceof Error ? error.message : 'Не удалось начать установку.', 'warning');
    }
  });
}
