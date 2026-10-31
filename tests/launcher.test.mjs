import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const batBytes = readFileSync(new URL('Hayumeri.bat', root));
const bat = batBytes.toString('ascii');
const launcher = readFileSync(new URL('scripts/start.ps1', root), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const index = readFileSync(new URL('index.html', root), 'utf8');
const ts = readFileSync(new URL('src/main.ts', root), 'utf8');

test('BAT is ASCII/CRLF without BOM and uses safe path handling', () => {
  assert.ok(batBytes.every(byte => byte < 128), 'batch contains non-ASCII bytes');
  assert.ok(bat.includes('\r\n'));
  assert.ok(!bat.replaceAll('\r\n', '').includes('\n'));
  assert.ok(!bat.startsWith('\uFEFF'));
  assert.match(bat, /DisableDelayedExpansion/);
  assert.match(bat, /pushd "%~dp0"/);
  assert.match(bat, /popd/);
  assert.match(bat, /"%CD%\\scripts\\start\.ps1"/);
  assert.match(bat, /SystemRoot%\\System32\\WindowsPowerShell/);
  assert.match(bat, /set "EXIT_CODE=%ERRORLEVEL%"/);
  assert.match(bat, /"%CI%"=="true"/);
});

test('portable Node.js is verified, pinned and downloaded over HTTPS', () => {
  assert.match(launcher, /\$version = 'v24\.22\.2'/);
  assert.match(launcher, /https:\/\/nodejs\.org\/dist\/\$version/);
  assert.match(launcher, /Get-Sha256 \$zip/);
  assert.doesNotMatch(launcher, /--version 2>\$null \| Select-Object -First 1/);
  assert.match(launcher, /SHA256]::Create/);
  assert.match(launcher, /SHASUMS256\.txt/);
  assert.match(launcher, /Get-WithRetry/);
  assert.match(launcher, /Expand-Archive/);
  assert.match(launcher, /NewGuid\(\)/);
  assert.match(launcher, /Get-WorkingNode \$target/);
});

test('prevents duplicates without killing unrelated user processes or requiring admin', () => {
  assert.match(launcher, /System\.Threading\.Mutex/);
  assert.match(launcher, /\$mutex\.WaitOne\(0\)/);
  assert.match(launcher, /ReleaseMutex\(\)/);
  assert.doesNotMatch(launcher, /Stop-Process|taskkill|Remove-Item[^\n]*node_modules/);
  assert.doesNotMatch(bat + launcher, /-Verb RunAs|runas \/user/i);
});

test('recognizes package.json, package-lock.json and Node version changes', () => {
  assert.match(launcher, /function Get-InstallFingerprint/);
  assert.match(launcher, /Get-Sha256 \$manifest/);
  assert.match(launcher, /Get-Sha256 \$lockfile/);
  assert.match(launcher, /\$nodeInfo\.version/);
  assert.match(launcher, /\$installedFingerprint -ne \$fingerprint/);
  assert.match(launcher, /Set-Content -LiteralPath \$marker -Value \(Get-InstallFingerprint\)/);
  assert.match(launcher, /-arguments @\('ci'/);
  assert.match(launcher, /-arguments @\('install'/);
});

test('starts only on localhost, saves logs and limits log growth', () => {
  assert.match(launcher, /-executable \$nodeInfo\.node -arguments @\(\$viteJs, '--host', '127\.0\.0\.1', '--port', '5173', '--open'\)/);
  assert.match(launcher, /-gt 4MB/);
  assert.match(launcher, /launch\.previous\.log/);
  assert.match(launcher, /Invoke-LoggedCommand/);
  assert.match(launcher, /node_modules\\vite\\bin\\vite\.js/);
  assert.match(launcher, /Add-Content -LiteralPath \$log/);
  assert.match(launcher, /\$env:NPM_CONFIG_CACHE/);
});

test('framework uses patched Vite 6 and a TypeScript application', () => {
  assert.equal(pkg.devDependencies.vite, '6.4.5');
  assert.equal(pkg.scripts.build, 'tsc --noEmit && vite build');
  assert.match(index, /src\/main\.ts/);
  assert.match(ts, /querySelector<HTMLDivElement>/);
});
