import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const text = path => readFileSync(new URL(path, root), 'utf8');
const compose = text('docker-compose.nosql.yml');
const bat = readFileSync(new URL('Hayumeri-DB.bat', root));
const ps = readFileSync(new URL('scripts/databases.ps1', root));
const packageFile = JSON.parse(text('server/package.json'));
const adapter = text('server/src/databases.ts');
const example = text('config/nosql.env.example');
const ignore = text('.gitignore');

test('four NoSQL services are defined, pinned and persistent', () => {
  for (const name of ['mongodb', 'redis', 'neo4j', 'qdrant']) {
    assert.match(compose, new RegExp('^  ' + name + ':', 'm'));
  }
  assert.match(compose, /mongo:8\.0\.30/);
  assert.match(compose, /redis:8\.2-alpine/);
  assert.match(compose, /neo4j:2026\.10\.1/);
  assert.match(compose, /qdrant\/qdrant:v1\.20\.0/);
  for (const name of ['mongodb_data', 'redis_data', 'neo4j_data', 'qdrant_data']) {
    assert.match(compose, new RegExp(name + ':'));
  }
  assert.doesNotMatch(compose, /\bimage:\s*\S+:latest\b/);
});

test('all exposed database ports are loopback only', () => {
  for (const port of ['27017', '6379', '7474', '7687', '6333']) {
    assert.match(compose, new RegExp('127\\.0\\.0\\.1:' + port + ':' + port));
  }
  const ports = [...compose.matchAll(/^\s+- "([^"]+)"\s*$/gm)].map(m => m[1]);
  assert.equal(ports.length, 5);
  for (const port of ports) assert.match(port, /^127\.0\.0\.1:\d+:\d+$/);
});

test('authentication and secrets are required; none are committed', () => {
  for (const secret of ['MONGO_PASSWORD', 'REDIS_PASSWORD', 'NEO4J_PASSWORD', 'QDRANT_API_KEY']) {
    assert.ok(compose.includes('$' + '{' + secret + ':?'));
    assert.ok(example.includes(secret + '=REPLACE_'));
  }
  assert.match(compose, /--requirepass/);
  assert.match(compose, /QDRANT__SERVICE__API_KEY/);
  assert.match(compose, /NEO4J_AUTH/);
  assert.match(ignore, /\.env\.\*/);
  assert.doesNotMatch(compose, /NEO4J_AUTH:\s*none/);
});

test('separate BAT uses ASCII/CRLF', () => {
  assert.ok(bat.every(byte => byte < 128));
  const content = bat.toString('ascii');
  assert.ok(content.includes('\r\n'));
  assert.ok(!content.replaceAll('\r\n', '').includes('\n'));
  assert.match(content, /DisableDelayedExpansion/);
  assert.match(content, /pushd "%~dp0"/);
  assert.match(content, /scripts\\databases\.ps1/);
  assert.match(content, /DB_ACTION/);
});

test('PowerShell initializes cryptographic secrets without destructive operations', () => {
  assert.ok(ps.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])));
  const content = ps.toString('utf8');
  assert.match(content, /RandomNumberGenerator/);
  assert.match(content, /\.env\.nosql/);
  assert.match(content, /File\]::Move/);
  assert.match(content, /Invoke-Compose -Arguments @\('up','-d'\)/);
  assert.match(content, /Invoke-Compose -Arguments @\('stop'\)/);
  assert.doesNotMatch(content, /down\s+--volumes|docker\s+volume\s+rm|compose\s+down\s+-v/);
});

test('four TypeScript drivers and isolated CRUD checks are provided', () => {
  for (const dep of ['mongodb', 'redis', 'neo4j-driver', '@qdrant/js-client-rest']) {
    assert.ok(packageFile.dependencies[dep], dep);
  }
  for (const fn of ['mongoClient', 'redisClient', 'graphClient', 'vectorClient', 'probeDatabases']) {
    assert.ok(adapter.includes('function ' + fn), fn);
  }
  assert.match(text('server/src/check.ts'), /probeDatabases/);
  assert.match(text('server/src/smoke.ts'), /hayumeri_smoke/);
  assert.match(text('server/src/smoke.ts'), /deleteCollection/);
});

test('Vite does not watch launcher status JSON or database backend files', () => {
  const vite = text('vite.config.ts');
  assert.match(vite, /\.runtime/);
  assert.match(vite, /logs/);
  assert.match(vite, /server/);
});
