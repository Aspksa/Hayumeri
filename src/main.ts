import './style.css';
import './workspace.css';
import './monitor.css';
import { initUpdateUi } from './update-ui';
import { initWorkspaceUi } from './workspace';
import packageManifest from '../package.json';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Application container is missing.');

app.innerHTML = `
  <a class="skip-link" href="#main-content">Перейти к содержимому</a>
  <div class="site-frame">
    <header class="topbar">
      <a class="brand" href="#main-content" aria-label="Hayumeri — на главную">
        <span class="brand-mark" aria-hidden="true">✧</span>
        <span class="brand-wordmark">HAYUMERI<span class="brand-caption">PRIVATE WORKSPACE</span></span>
      </a>
      <nav class="header-nav" aria-label="Навигация по странице">
        <a href="#platform">Возможности</a>
        <a href="#foundation">Технологии</a>
      </nav>
      <div class="topbar-actions">
        <span class="version">v${packageManifest.version}</span>
        <button class="update-trigger" id="update-trigger" type="button" aria-label="Обновления проекта" title="Обновления GitHub">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.6 4.5M20 20v-4.5h-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span id="update-indicator" class="update-indicator" hidden></span>
        </button>
      </div>
    </header>

    <div class="app-layout">
      <aside class="app-sidebar" aria-label="Рабочие пространства">
        <div class="sidebar-intro"><span class="sidebar-overline">H / WORKSPACE</span><strong>Пространства</strong><small>Всё необходимое рядом</small></div>
        <nav class="workspace-navigation" id="workspace-navigation" aria-label="Выбор рабочего раздела"></nav>
        <div class="sidebar-footer"><span class="sidebar-status-dot" aria-hidden="true"></span><span>Локальное приложение<br><small>Заметки и задачи сохраняются в .runtime</small></span></div>
      </aside>
      <main id="main-content" class="shell">
        <div id="home-view">
      <section class="hero" aria-labelledby="welcome-title">
        <div class="hero-copy">
          <div class="eyebrow"><span class="status-dot" aria-hidden="true"></span><span>ЛОКАЛЬНАЯ СРЕДА · WINDOWS</span><span class="eyebrow-rule" aria-hidden="true"></span><span class="eyebrow-edition">EDITION 01</span></div>
          <div class="hero-overline">ЦИФРОВОЕ ПРОСТРАНСТВО</div>
          <h1 id="welcome-title">Твоя идея.<br><em>Твоя система.</em></h1>
          <p class="hero-lede">Hayumeri — основа личного цифрового пространства. Локальный запуск, контроль версий и инфраструктура для будущих инструментов знаний и ИИ.</p>
          <div class="hero-actions">
            <a class="action-primary" href="#platform"><span>Исследовать платформу</span><span class="button-arrow" aria-hidden="true">↗</span></a>
            <a class="action-secondary" href="https://github.com/Aspksa/Hayumeri" target="_blank" rel="noopener noreferrer"><span>Репозиторий GitHub</span><span aria-hidden="true">↗</span></a>
          </div>
          <div class="hero-status"><span class="hero-status-line" aria-hidden="true"></span><span>Локальный веб-сайт запущен · Рабочие модули развиваются поэтапно</span></div>
        </div>
        <div class="hero-art" aria-hidden="true">
          <div class="art-grid"></div>
          <div class="art-aura"></div>
          <div class="art-ring art-ring-outer"></div>
          <div class="art-ring art-ring-middle"></div>
          <div class="art-ring art-ring-inner"></div>
          <div class="art-orbit art-orbit-a"></div>
          <div class="art-orbit art-orbit-b"></div>
          <div class="art-cross art-cross-horizontal"></div>
          <div class="art-cross art-cross-vertical"></div>
          <div class="art-core"><div class="art-core-inner">✧</div></div>
          <span class="art-satellite art-satellite-a"></span>
          <span class="art-satellite art-satellite-b"></span>
          <div class="art-label art-label-top">H / SYSTEM 001</div>
          <div class="art-label art-label-bottom">FORM FOLLOWS PURPOSE</div>
          <div class="art-corner art-corner-tl"></div><div class="art-corner art-corner-br"></div>
        </div>
        <div class="hero-index" aria-hidden="true">01 <span>/</span> HAYUMERI</div>
      </section>

      <section id="foundation" class="foundation" aria-labelledby="foundation-title">
        <div class="section-heading">
          <div><span class="section-kicker">01 / ФУНДАМЕНТ</span><h2 id="foundation-title">Построено на ясной основе.</h2></div>
          <p>Лёгкая локальная архитектура без лишней сложности.</p>
        </div>
        <div class="facts" aria-label="Технологии платформы">
          <div class="fact"><div class="fact-top"><span>01 / ЯЗЫК</span><span class="fact-glyph" aria-hidden="true">⌘</span></div><strong>TypeScript</strong><small>Типизированная основа</small></div>
          <div class="fact"><div class="fact-top"><span>02 / СРЕДА</span><span class="fact-glyph" aria-hidden="true">◇</span></div><strong>Vite</strong><small>Быстрый локальный интерфейс</small></div>
          <div class="fact"><div class="fact-top"><span>03 / ЗАПУСК</span><span class="fact-glyph" aria-hidden="true">↗</span></div><strong>Windows</strong><small>Hayumeri.bat · без прав администратора</small></div>
        </div>
      </section>

      <section id="platform" class="platform" aria-labelledby="platform-title">
        <div class="section-heading">
          <div><span class="section-kicker">02 / ВОЗМОЖНОСТИ</span><h2 id="platform-title">Инструменты под контролем.</h2></div>
          <p>Здесь показаны только предусмотренные проектом возможности — без вымышленных данных.</p>
        </div>
        <div class="feature-grid">
          <article class="feature-card">
            <span class="feature-no">01 <span aria-hidden="true">/</span></span>
            <div class="feature-emblem" aria-hidden="true">↺</div>
            <h3>Обновления GitHub</h3>
            <p>Проверка ревизий, резервная копия и установка с восстановлением при сбое.</p>
            <span class="feature-foot">ДОСТУПНО ЧЕРЕЗ ЗНАЧОК В ШАПКЕ</span>
          </article>
          <article class="feature-card">
            <span class="feature-no">02 <span aria-hidden="true">/</span></span>
            <div class="feature-emblem" aria-hidden="true">▦</div>
            <h3>Инфраструктура данных</h3>
            <p>MongoDB, Redis, Neo4j и Qdrant включены как отдельные сервисы. Для запуска нужен Docker.</p>
            <span class="feature-foot">ЗАПУСКАЕТСЯ ОТДЕЛЬНО ОТ САЙТА</span>
          </article>
        </div>
      </section>
        </div>
        <section id="workspace-view" class="workspace-view" hidden aria-labelledby="workspace-title"></section>
      </main>
    </div>

    <div id="workspace-live-status" class="workspace-live-status" role="status" aria-live="polite" aria-atomic="true"></div>
    <footer class="site-footer">
      <span class="footer-brand"><span aria-hidden="true">✧</span> HAYUMERI</span>
      <span>Локальная среда · Постепенное развитие</span>
      <a href="https://github.com/Aspksa/Hayumeri/blob/main/README.md" target="_blank" rel="noopener noreferrer">Документация <span aria-hidden="true">↗</span></a>
    </footer>
  </div>
`;

initUpdateUi();
initWorkspaceUi();
