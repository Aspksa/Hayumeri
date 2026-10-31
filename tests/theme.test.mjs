import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

test('black and gold theme is defined in centralized design tokens', () => {
  assert.match(css, /--background:\s*#080808\b/i);
  assert.match(css, /--surface:\s*#11100e\b/i);
  assert.match(css, /--text-primary:\s*#f5f1e8\b/i);
  assert.match(css, /--gold:\s*#d4af37\b/i);
  assert.match(css, /--gold-light:\s*#f0d77e\b/i);
  assert.match(css, /background:\s*var\(--background\)/);
  assert.doesNotMatch(css, /#111722|#263649|#18212f|#1c2635|#93a0b0|#81c9a1/i);
});

test('golden styling covers page, cards, buttons and update dialog', () => {
  for (const selector of [
    '.brand', '.topbar', '.hero h1 em', '.fact', '.status-dot',
    '.update-trigger', '.update-dialog', '.update-versions',
    '.update-status', '.update-check', '.update-install'
  ]) {
    assert.ok(css.includes(selector), selector);
  }
  assert.match(css, /\.update-dialog\s*\{[^}]*background:\s*#10100e/s);
  assert.match(css, /\.update-install\s*\{[^}]*background:\s*linear-gradient/s);
  assert.match(css, /\.update-trigger\s*\{[^}]*color:\s*var\(--gold-light\)/s);
});

test('black-gold design remains readable and keyboard/mobile accessible', () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /outline:\s*2px solid var\(--gold-light\)/);
  assert.match(css, /@media \(max-width:\s*600px\)/);
  assert.match(css, /@media \(max-width:\s*370px\)/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.update-controls button:disabled/);
  assert.match(css, /\.update-indicator:not\(\[hidden\]\)/);
});
