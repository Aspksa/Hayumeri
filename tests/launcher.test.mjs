import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const batBytes = readFileSync(new URL('Hayumeri.bat', root));
const bat = batBytes.toString('ascii');
const launcher = readFileSync(new URL('scripts/start.ps1', root), 'utf8');
const helpers = readFileSync(new URL('scripts/launcher-helpers.ps1', root), 'utf8');
const integrity = JSON.parse(readFileSync(new URL('config/integrity.json', root), 'utf8'));
const settings = JSON.parse(readFileSync(new URL('config/launcher.json', root), 'utf8'));
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
  assert.match(launcher, /Stop-Process -Id \$server\.Id/);
  assert.doesNotMatch(launcher, /taskkill|Remove-Item[^\n]*node_modules/);
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
  assert.match(launcher, /Start-Process -FilePath \$nodeInfo\.node/);
  assert.match(launcher, /'--strictPort'/);
  assert.match(launcher, /Test-HealthySite \$address/);
  assert.doesNotMatch(launcher, /--open'\)/);
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


test('UTF-8 BOM preserved for Russian in Windows PowerShell 5.1', () => {
  assert.ok(readFileSync(new URL('scripts/start.ps1', root)).subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])));
  assert.ok(readFileSync(new URL('scripts/launcher-helpers.ps1', root)).subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])));
  assert.match(launcher, /РАБОТАЕТ/);
  assert.match(helpers, /ПРОВЕРКА/);
});

test('integrity manifest has unique, safe paths and exact SHA-256 sums', () => {
  assert.equal(integrity.schema, 1);
  assert.ok(integrity.files.length >= 5);
  const seen = new Set();
  for (const entry of integrity.files) {
    assert.match(entry.path, /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/);
    assert.ok(!entry.path.includes('..'));
    assert.ok(!seen.has(entry.path));
    seen.add(entry.path);
    assert.ok(existsSync(new URL(entry.path, root)));
    const actual = createHash('sha256').update(readFileSync(new URL(entry.path, root))).digest('hex');
    assert.equal(actual, entry.sha256, entry.path);
  }
});

test('strict configuration and bounded restart attempts', () => {
  assert.ok(Number.isInteger(settings.preferredPort));
  assert.ok(settings.maxPort >= settings.preferredPort);
  assert.ok(settings.maxAttempts >= 1 && settings.maxAttempts <= 3);
  assert.match(helpers, /function Read-LauncherConfig/);
  assert.match(helpers, /function Test-PortAvailable/);
  assert.match(launcher, /Get-FreePort/);
  assert.match(launcher, /-le \$config\.maxAttempts/);
  assert.match(launcher, /Сайт не ответил/);
});

test('diagnostic status, launch timing and browser gating are wired', () => {
  assert.match(helpers, /launcher-status\.json/);
  assert.match(helpers, /launch-metrics\.json/);
  assert.match(launcher, /timings\['preflight'\]/);
  assert.match(launcher, /timings\['dependencies'\]/);
  assert.match(launcher, /timings\['readiness'\]/);
  assert.match(launcher, /Set-LaunchStatus 'РАБОТАЕТ'/);
  assert.match(launcher, /if \(\$ready\)/);
  assert.match(launcher, /Start-Process -FilePath \$address/);
  assert.match(helpers, /Test-Dependencies/);
});


test('Vite child survives noninteractive Windows stdin without altering the BAT browser mode', () => {
  assert.match(launcher, /\\$originalCI = \\$env:CI/);
  assert.match(launcher, /\\$env:CI = 'true'/);
  assert.match(launcher, /Remove-Item -Path Env:CI/);
  assert.match(launcher, /\\$env:CI = \\$originalCI/);
  assert.match(launcher, /if \\(\\$config\\.openBrowser -and \\$env:CI -ne 'true'\\)/);
  assert.match(launcher, /\\$serverExitCode = \\$null/);
  assert.match(launcher, /if \\(\\$null -eq \\$serverExitCode\\)/);
  assert.match(launcher, /if \\(\\[int\\]\\$serverExitCode -eq 75\\)/);
  assert.match(launcher, /if \\(\\[int\\]\\$serverExitCode -ne 0\\)/);
});
