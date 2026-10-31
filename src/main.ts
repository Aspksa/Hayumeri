import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Application container is missing.');

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark" aria-hidden="true">✧</span> HAYUMERI</div>
      <span class="version">v0.1.0 · Стартовая основа</span>
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
