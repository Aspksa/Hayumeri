import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('semantic premium page uses real sections and keeps GitHub updates', () => {
  assert.match(main, /<header class="topbar">/);
  assert.match(main, /<main id="main-content" class="shell">/);
  assert.match(main, /<section class="hero" aria-labelledby="welcome-title">/);
  assert.match(main, /<section id="foundation"/);
  assert.match(main, /<section id="platform"/);
  assert.match(main, /<footer class="site-footer">/);
  assert.match(main, /href="#platform"/);
  assert.match(main, /href="#foundation"/);
  assert.match(main, /id="update-trigger"/);
  assert.match(main, /id="update-indicator"/);
  assert.match(main, /initUpdateUi\(\)/);
});

test('all calls to action lead to actual locations, not placeholder pages', () => {
  assert.match(main, /href="https:\/\/github\.com\/Aspksa\/Hayumeri"/);
  assert.match(main, /href="https:\/\/github\.com\/Aspksa\/Hayumeri\/blob\/main\/README\.md"/);
  assert.match(main, /href="#platform"/);
  assert.doesNotMatch(main, /href="#"/);
  assert.match(main, /rel="noopener noreferrer"/);
});

test('decorative artwork uses CSS only, never masks real service status', () => {
  assert.match(main, /class="hero-art" aria-hidden="true"/);
  assert.match(css, /\.art-core/);
  assert.match(css, /\.art-ring-outer/);
  assert.match(css, /\.art-orbit-a/);
  assert.match(css, /\.art-grid/);
  assert.doesNotMatch(main, /mock data|100% uptime|подключено 4 из 4|онлайн 4\/4/i);
  assert.match(main, /Для запуска нужен Docker/);
  assert.match(main, /Рабочие модули развиваются поэтапно/);
});

test('page remains keyboard friendly, responsive and reduced-motion aware', () => {
  assert.match(main, /class="skip-link" href="#main-content"/);
  assert.match(css, /\.skip-link:focus/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(max-width: 600px\)/);
  assert.match(css, /@media \(max-width: 370px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /scroll-behavior: auto/);
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /name="theme-color" content="#080808"/);
});

test('main header draws current app version from package.json', () => {
  assert.match(main, /import packageManifest from '\.\.\/package\.json'/);
  assert.match(main, /packageManifest\.version/);
  assert.doesNotMatch(main, /v0\.2\.0/);
});
