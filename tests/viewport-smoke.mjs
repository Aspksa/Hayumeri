// Real Chromium/Edge viewport checks with the native Node 24 WebSocket API.
// No Playwright, Selenium or extra NPM dependencies are required.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
if (!url || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) {
  throw new Error('Pass the running localhost URL, e.g. http://127.0.0.1:5173/');
}
const browserCandidates = [
  process.env.HAYUMERI_TEST_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);
const browser = browserCandidates.find(path => existsSync(path));
assert.ok(browser, 'A locally installed Microsoft Edge or Chrome is required for viewport checks');
const profile = mkdtempSync(join(tmpdir(), 'hayumeri-monitor-check-'));
const child = spawn(browser, [
  '--headless=new', '--disable-extensions', '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking',
  '--remote-allow-origins=*', '--remote-debugging-port=0',
  '--user-data-dir=' + profile, 'about:blank'
], { stdio: 'ignore', windowsHide: true });
let ws;
let id = 0;
const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const key = ++id;
    const timeout = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(key, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id: key, method, params }));
  });
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error('Browser evaluation error: ' + expression.slice(0, 200));
  return response.result.value;
}
async function waitFor(expression, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await evaluate(expression)) return; } catch { /* navigation ongoing */ }
    await sleep(120);
  }
  throw new Error('Page did not settle: ' + expression);
}
async function setViewport(width, height, scale) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: scale, mobile: false, screenWidth: width, screenHeight: height
  });
}
async function audit(width, height, scale, route) {
  await setViewport(width, height, scale);
  await send('Page.navigate', { url: url + (route === 'home' ? '#home' : '#' + route) });
  await waitFor(route === 'home'
    ? "document.querySelector('#home-view') && !document.querySelector('#home-view').hidden && document.querySelectorAll('.workspace-nav-item').length === 10"
    : "document.querySelector('#workspace-title') && !document.querySelector('#workspace-view').hidden && document.querySelector('#workspace-title').textContent.length > 0");
  const result = await evaluate(`(() => {
    const root = document.documentElement;
    const body = document.body;
    const frame = document.querySelector('.site-frame');
    const layout = document.querySelector('.app-layout');
    const nav = document.querySelector('.workspace-navigation');
    const editor = document.querySelector('.note-layout');
    const form = document.querySelector('.task-form');
    const version = document.querySelector('.version');
    const updater = document.querySelector('#update-trigger');
    const width = window.innerWidth;
    const useful = el => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x:r.x, right:r.right, width:r.width, height:r.height };
    };
    return {
      width, deviceScale:window.devicePixelRatio,
      documentWidth:Math.max(root.scrollWidth,body.scrollWidth),
      frame:useful(frame),
      layoutDisplay:getComputedStyle(layout).display,
      nav:useful(nav), navScrollWidth:nav.scrollWidth, navClientWidth:nav.clientWidth,
      navOverflow:getComputedStyle(nav).overflowX,
      sidebar:useful(document.querySelector('.app-sidebar')),
      updater:useful(updater), version:useful(version),
      editor:useful(editor), taskForm:useful(form),
      hero:useful(document.querySelector('#home-view .hero')),
      heading:useful(document.querySelector('#workspace-title'))
    };
  })()`);
  assert.equal(result.width, width, 'Incorrect CSS viewport width');
  assert.ok(result.frame?.width > 0, 'Missing app frame');
  assert.ok(result.documentWidth <= width + 2,
    `Horizontal page overflow at ${width}x${height}, DPR=${scale}, route=${route}: document=${result.documentWidth}`);
  assert.ok(result.frame.x >= -1 && result.frame.right <= width + 1,
    `Frame left viewport: ${width}, ${route}, ${JSON.stringify(result.frame)}`);
  assert.ok(result.updater?.width >= 40 && result.updater.right <= width + 2,
    `GitHub update control clipped on ${width}px`);
  assert.equal(result.layoutDisplay, width <= 930 ? 'block' : 'grid',
    `Wrong sidebar layout at ${width}px`);
  if (width <= 930) assert.ok(result.navOverflow === 'auto' || result.navOverflow === 'scroll',
    'Narrow viewport must scroll the navigation independently');
  if (width >= 1850) assert.ok(result.frame.width >= 1580,
    `Wide screen wasted space: ${width}, frame=${result.frame.width}`);
  if (route === 'notes') assert.ok(result.editor && result.editor.width > 0 && result.editor.right <= width + 2,
    `Note editor clipped at ${width}px`);
  if (route === 'tasks') assert.ok(result.taskForm && result.taskForm.width > 0 && result.taskForm.right <= width + 2,
    `Task form clipped at ${width}px`);
  console.log(`PASS ${width}x${height} DPR=${scale} ${route}; frame=${Math.round(result.frame.width)}px; ${result.layoutDisplay}`);
}
try {
  let port;
  for (let i = 0; i < 180; i++) {
    const active = join(profile, 'DevToolsActivePort');
    if (existsSync(active)) {
      port = Number(readFileSync(active, 'utf8').split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) break;
    }
    if (child.exitCode !== null) throw new Error('Headless browser exited before CDP was ready');
    await sleep(100);
  }
  assert.ok(port, 'Headless browser did not open the debugging port');
  let pages;
  for (let i = 0; i < 25; i++) {
    try {
      pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      if (pages.some(x => x.type === 'page')) break;
    } catch { /* browser still initializing */ }
    await sleep(120);
  }
  const page = pages?.find(x => x.type === 'page');
  assert.ok(page?.webSocketDebuggerUrl, 'Browser has no inspectable page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const task = pending.get(message.id);
    if (!task) return;
    clearTimeout(task.timeout);
    pending.delete(message.id);
    if (message.error) task.reject(new Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  });
  await send('Page.enable');
  await send('Runtime.enable');
  const cases = [
    [320, 640, 1], [360, 720, 2], [600, 900, 1],
    [768, 1024, 2], [930, 800, 1], [1024, 600, 1.25],
    [1280, 720, 1], [1366, 768, 1], [1536, 864, 1.25],
    [1920, 1080, 1], [2560, 1440, 1.5],
    [3440, 1440, 1], [3840, 2160, 2]
  ];
  for (const [width, height, scale] of cases) {
    for (const route of ['home', 'notes', 'tasks']) await audit(width, height, scale, route);
  }
  console.log(`Browser viewport checks succeeded: ${cases.length * 3} real-layout scenarios.`);
  // Exercise actual UI interactions (not only CSS existence).
  await setViewport(1366, 768, 1);
  await send('Page.navigate', { url: url + '#notes' });
  await waitFor("document.querySelector('.note-layout') && document.querySelectorAll('.workspace-nav-item').length === 10");
  const start = await evaluate("Math.round(document.querySelector('.app-sidebar').getBoundingClientRect().width)");
  await evaluate("document.querySelector('#sidebar-toggle').click()");
  const collapsed = await evaluate("document.querySelector('.app-layout').dataset.sidebarCollapsed === 'true' && document.querySelector('.app-sidebar').getBoundingClientRect().width < 100");
  assert.ok(collapsed, 'Sidebar did not collapse when its button was clicked');
  await evaluate("document.querySelector('#sidebar-toggle').click()");
  await waitFor("document.querySelector('.app-layout').dataset.sidebarCollapsed === 'false'");
  const restored = await evaluate("Math.round(document.querySelector('.app-sidebar').getBoundingClientRect().width)");
  assert.ok(restored >= start - 4, 'Sidebar did not expand to original width');

  await evaluate("document.querySelector('#settings-trigger').click()");
  assert.equal(await evaluate("document.querySelector('#preferences-dialog').open"), true,
    'Preferences dialog did not open');
  await evaluate(`(() => { const slider = document.querySelector('[data-setting="fontScale"]'); slider.value = '115'; slider.dispatchEvent(new Event('input',{bubbles:true})); return true })()`);
  await waitFor("getComputedStyle(document.documentElement).getPropertyValue('--ui-font-scale').trim() === '1.15'");
  await evaluate("document.querySelector('[data-close-settings]').click()");
  await evaluate("document.querySelector('[data-pin-route=agents]').click()");
  await waitFor("document.querySelector('[data-pin-route=agents]').getAttribute('aria-pressed') === 'true'");
  await evaluate("document.querySelector('#command-trigger').click()");
  assert.equal(await evaluate("document.querySelector('#command-dialog').open"), true,
    'Command palette did not open');
  await evaluate(`(() => {const q=document.querySelector('#command-query');q.value='Агенты';q.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  const match = await evaluate("document.querySelectorAll('.command-item').length === 1 && document.querySelector('.command-item').textContent.includes('Агенты')");
  assert.ok(match, 'Command search did not filter workspace routes');
  await evaluate("document.querySelector('[data-close-commands]').click()");
  await sleep(1000);
  const persisted = await evaluate("fetch('/api/preferences/data',{cache:'no-store'}).then(r=>r.json())");
  assert.equal(persisted.sidebarCollapsed, false);
  assert.equal(persisted.fontScale, 1.15);
  assert.ok(persisted.pinned.includes('agents'), 'Pinned route not saved to .runtime');
  assert.ok(persisted.revision >= 1, 'No preferences revision increment');

  await send('Page.reload', { ignoreCache: true });
  await waitFor("document.querySelector('#command-trigger') && document.querySelector('[data-pin-route=agents]') && getComputedStyle(document.documentElement).getPropertyValue('--ui-font-scale').trim() === '1.15'");
  const reloadedPin = await evaluate("document.querySelector('[data-pin-route=agents]').getAttribute('aria-pressed')");
  assert.equal(reloadedPin, 'true', 'Pinned workspace not restored after page reload');
  console.log('PASS persisted settings, sidebar collapse, command filtering and pinned routes.');

} finally {
  ws?.close();
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
  for (const task of pending.values()) { clearTimeout(task.timeout); task.reject(new Error('Closing browser')); }
  rmSync(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
}
