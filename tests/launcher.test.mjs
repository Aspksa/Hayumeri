import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const bat = readFileSync(new URL('Hayumeri.bat', root));
const launcher = readFileSync(new URL('scripts/start.ps1', root), 'utf8');

test('BAT uses ASCII with CRLF (Windows cmd compatibility)', () => {
  assert.ok(bat.every((byte) => byte < 128));
  const text = bat.toString('ascii');
  assert.ok(text.includes('\r\n'));
  assert.ok(!text.replaceAll('\r\n', '').includes('\n'));
  assert.match(text, /DisableDelayedExpansion/);
  assert.match(text, /cd \/d "%~dp0"/);
});

test('launcher verifies downloaded Node and does not require admin', () => {
  assert.match(launcher, /SHASUMS256\.txt/);
  assert.match(launcher, /Get-FileHash -LiteralPath \$zip -Algorithm SHA256/);
  assert.match(launcher, /\.runtime/);
  assert.match(launcher, /npm install/);
  assert.match(launcher, /--host 127\.0\.0\.1/);
  assert.doesNotMatch(launcher, /Start-Process[^\r\n]*-Verb RunAs/);
});
