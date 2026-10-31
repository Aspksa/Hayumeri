import './style.css';
import { initUpdateUi } from './update-ui';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Application container is missing.');

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark" aria-hidden="true">✧</span> HAYUMERI</div>
      <div class="topbar-actions"><span class="version">v0.2.0 · Стартовая основа</span><button class="update-trigger" id="update-trigger" type="button" aria-label="Обновления проекта" title="Обновления GitHub"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.6 4.5M20 20v-4.5h-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg><span id="update-indicator" class="update-indicator" hidden></span></button></div>
    </header>
    <section class="hero" aria-labelledby="welcome-title">
      <span class="eyebrow"><span class="status-dot"></span> Локальная среда работает</span>
      <h1 id="welcome-title">Добро пожаловать в <em>Hayumeri</em></h1>
      <p>Базовая веб-версия готова к развитию. Приложение запускается одним файлом Hayumeri.bat и работает локально на вашем компьютере.</p>
      <div class="facts">
        <div class="fact"><span>Основной язык</span><strong>TypeScript</strong></div>
        <div class="fact"><span>Веб-среда</span><strong>Vite</strong></div>
        <div class="fact"><span>Режим</span><strong>Локальный</strong></div>
      </div>
    </section>
    <footer>Hayumeri · Начальный каркас. Функциональные модули пока не добавлены.</footer>
  </main>
`;

initUpdateUi();
