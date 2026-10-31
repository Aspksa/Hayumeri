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


test('balanced NoSQL profile increases room for growth without unlimited memory', () => {
  const expected = {
    HAYUMERI_MONGO_LIMIT: '1536m',
    HAYUMERI_REDIS_LIMIT: '512m',
    HAYUMERI_NEO4J_LIMIT: '2048m',
    HAYUMERI_QDRANT_LIMIT: '2048m'
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.ok(compose.includes('${' + key + ':-' + value + '}'), key);
  }
  assert.match(compose, /\-\-wiredTigerCacheSizeGB/);
  assert.match(compose, /HAYUMERI_MONGO_CACHE_GB:-0\.5/);
  assert.match(compose, /HAYUMERI_REDIS_MAXMEMORY:-256mb/);
  assert.match(compose, /--maxmemory-policy noeviction/);
  assert.doesNotMatch(compose, /allkeys-lru/);
  assert.match(compose, /HAYUMERI_NEO4J_HEAP:-768m/);
  assert.match(compose, /HAYUMERI_NEO4J_PAGECACHE:-512m/);
  // Persistent database data must never be silently evicted.
  assert.match(compose, /--appendonly yes/);
});

test('growth profile is explicit, persisted only after successful Compose startup', () => {
  const script = ps.toString('utf8');
  assert.match(script, /Get-ResourceProfile/);
  assert.match(script, /Save-ResourceProfile/);
  assert.match(script, /Set-ResourceEnvironment/);
  assert.match(script, /Assert-AvailableMemory/);
  assert.match(script, /\$gib -lt 9/);
  assert.match(script, /'balanced','growth'/);
  assert.match(script, /HAYUMERI_MONGO_LIMIT = '2048m'/);
  assert.match(script, /HAYUMERI_NEO4J_LIMIT = '2560m'/);
  assert.match(script, /HAYUMERI_QDRANT_LIMIT = '2560m'/);
  assert.match(script, /HAYUMERI_REDIS_LIMIT = '640m'/);
  assert.match(script, /\[IO\.File\]::Replace/);
  assert.match(script, /nosql-profile\.json/);
  assert.match(script, /nosql-profile\.previous\.json/);
  // The order is important: never save the new resource profile until Docker accepts it.
  const growth = script.slice(script.indexOf("    'growth' {"));
  assert.ok(growth.indexOf("Invoke-Compose -Arguments @('up','-d')") < growth.indexOf('Save-ResourceProfile $activeProfile'));
  assert.match(script, /'stats' \{ Show-Resources/);
  assert.doesNotMatch(script, /docker\s+volume\s+rm|down\s+-v|down\s+--volumes/);
});

test('database resource profile can be inspected without Docker or revealing credentials', () => {
  const script = ps.toString('utf8');
  const segment = script.slice(script.indexOf("if ($Action -eq 'help')"), script.indexOf("if (-not (Test-Path -LiteralPath $compose"));
  assert.ok(segment.includes("if ($Action -eq 'resources')"), 'resources action must run before credential checks');
  assert.ok(segment.includes('exit 0'));
  assert.match(script, /Get-Content -LiteralPath \$profileFile -Raw -Encoding UTF8/);
  assert.match(script, /Неверный формат|Неизвестный профиль/);
});
