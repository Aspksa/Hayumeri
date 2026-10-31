import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const css = read('src/monitor.css');
const main = read('src/main.ts');
const browser = read('tests/viewport-smoke.mjs');
const workflow = read('.github/workflows/windows-launch.yml');

test('monitor layout is loaded after base/theme/workspace styles', () => {
  assert.match(main, /import '\.\/style\.css';[\s\S]*import '\.\/workspace\.css';[\s\S]*import '\.\/monitor\.css';/);
  assert.match(css, /--monitor-shell-max:\s*2304px/);
  assert.match(css, /--monitor-sidebar:/);
  assert.match(css, /\.app-layout\s*\{[\s\S]*?minmax\(0, 1fr\)/);
  assert.match(css, /\.app-layout > \.shell\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /\.note-layout\s*\{[^}]*max-width:\s*1680px/s);
  assert.match(css, /\.workspace-textarea\s*\{[^}]*min-height:\s*clamp/s);
});

test('responsive viewports include monitor, ultrawide, laptop, portrait and low-height windows', () => {
  for (const query of [
    '@media (min-width: 1850px)',
    '@media (min-width: 2560px)',
    '@media (max-width: 1399px) and (min-width: 931px)',
    '@media (max-width: 930px)',
    '@media (max-width: 760px)',
    '@media (max-width: 600px)',
    '@media (max-width: 370px)',
    '@media (max-height: 740px) and (min-width: 931px)'
  ]) assert.ok(css.includes(query), query);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /transform:\s*scale\(/);
});

test('browser actually tests document overflow and working editor/toolbar', () => {
  assert.match(browser, /Emulation\.setDeviceMetricsOverride/);
  assert.match(browser, /documentWidth <= width \+ 2/);
  assert.match(browser, /layoutDisplay/);
  assert.match(browser, /route === 'notes'/);
  assert.match(browser, /route === 'tasks'/);
  for (const width of [320,360,600,768,930,1024,1280,1366,1536,1920,2560,3440,3840]) {
    assert.match(browser, new RegExp('\\[' + width + ','));
  }
  assert.match(workflow, /node tests\/viewport-smoke\.mjs/);
  assert.match(workflow, /Real Chromium monitor layout checks failed/);
});
