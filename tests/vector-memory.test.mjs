import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../server/src/vector-memory.ts', import.meta.url), 'utf8');
const smoke = readFileSync(new URL('../server/src/vector-memory-smoke.ts', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../server/package.json', import.meta.url), 'utf8'));
const workflow = readFileSync(new URL('../.github/workflows/nosql-integration.yml', import.meta.url), 'utf8');

test('vector memory is a real server-side Qdrant component, with no browser secrets', () => {
  assert.match(source, /import type \{ QdrantClient \} from '@qdrant\/js-client-rest'/);
  assert.match(source, /export class VectorMemory/);
  assert.match(source, /getCollections\(\)/);
  assert.match(source, /createCollection\(/);
  assert.match(source, /getCollection\(/);
  assert.match(source, /client\.upsert\(/);
  assert.match(source, /client\.query\(/);
  assert.match(source, /client\.delete\(/);
  assert.match(source, /client\.count\(/);
  assert.doesNotMatch(source, /process\.env|apiKey|createClient\(/);
});

test('memory source IDs are deterministic, and knowledge remains source-linked', () => {
  assert.match(source, /createHash\('sha256'\)/);
  assert.match(source, /namespace, input\.sourceId, input\.chunkId/);
  assert.match(source, /sourceHash: input\.sourceHash/);
  assert.match(source, /revision: input\.revision/);
  assert.match(source, /recordedAt: input\.recordedAt/);
  assert.match(source, /sourceId: input\.sourceId/);
  assert.match(source, /const ids = new Set<string>/);
});

test('Qdrant memory stores vectors and indexes on disk with no global entry count cap', () => {
  assert.match(source, /on_disk: true/);
  assert.match(source, /hnsw_config: \{ on_disk: true \}/);
  assert.match(source, /on_disk_payload: true/);
  assert.match(source, /Incompatible existing Qdrant collection; data left untouched/);
  assert.match(source, /start \+= 64/);
  assert.doesNotMatch(source, /recreateCollection|deleteCollection|allkeys-lru/);
});

test('recall isolates namespace, model and optional source', () => {
  assert.match(source, /modelId: this\.modelId/);
  assert.match(source, /key: 'namespace'/);
  assert.match(source, /key: 'modelId'/);
  assert.match(source, /key: 'sourceId'/);
  assert.match(source, /score_threshold: scoreThreshold/);
  assert.match(source, /with_vector: false/);
  assert.match(source, /Invalid embedding vector/);
  assert.match(source, /Preview too large/);
});

test('real memory smoke is executed by the Docker CI, not only static checks', () => {
  assert.equal(pkg.scripts['memory:smoke'], 'tsx src/vector-memory-smoke.ts');
  assert.match(workflow, /npm --prefix server run memory:smoke/);
  assert.match(smoke, /memory\.remember/);
  assert.match(smoke, /memory\.recall/);
  assert.match(smoke, /memory\.forgetSource/);
  assert.match(smoke, /memory\.count/);
  assert.match(smoke, /namespace !== 'private_a'/);
});
