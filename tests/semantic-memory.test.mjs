import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {splitNote} from '../scripts/semantic-memory-api.ts';

const source=readFileSync(new URL('../scripts/semantic-memory-api.ts',import.meta.url),'utf8');
const vite=readFileSync(new URL('../vite.config.ts',import.meta.url),'utf8');
const workspace=readFileSync(new URL('../src/workspace.ts',import.meta.url),'utf8');
const storage=readFileSync(new URL('../scripts/workspace-api.ts',import.meta.url),'utf8');

test('chunker is bounded, preserves text, makes forward progress on long notes',()=>{
  assert.deepEqual(splitNote(''),[]);
  assert.deepEqual(splitNote('  Привет  '),['Привет']);
  const text='Векторная память на русском. '.repeat(210);
  const chunks=splitNote(text);
  assert.ok(chunks.length>3);
  assert.ok(chunks.every(chunk=>chunk.length<=1200&&chunk.length>0));
  assert.ok(chunks.length<100);
  assert.ok(chunks[0].startsWith('Векторная память'));
  assert.ok(chunks.at(-1).endsWith('русском.'));
});

test('local real Ollama API returns real embeddings, not synthetic vectors or cloud uploads',()=>{
  assert.match(source,/127\.0\.0\.1:11434/);
  assert.match(source,/\/api\/embed/);
  assert.match(source,/\/api\/tags/);
  assert.match(source,/\/api\/pull/);
  assert.match(source,/model:MODEL,input:texts,truncate:false/);
  assert.match(source,/Number\.isFinite/);
  assert.match(source,/embeddings\.length!==texts\.length/);
  assert.doesNotMatch(source,/Math\.random\(|randomBytes|openai\.com|api\.cloud\.ru/);
});

test('Qdrant on-disk storage, bounded batches and source-verified search',()=>{
  assert.match(source,/on_disk:true/);
  assert.match(source,/on_disk_payload:true/);
  assert.match(source,/hnsw_config:\{on_disk:true\}/);
  assert.match(source,/points\/query/);
  assert.match(source,/points\/delete\?wait=true/);
  assert.match(source,/must_not:\[\{key:'sourceHash'/);
  assert.match(source,/sourceHash,revision:sourceHash/);
  assert.match(source,/index\.revisions\[p\.sourceId\]/);
  assert.match(source,/new Map\(notes\(\)\.map/);
  assert.match(source,/offset\+=32/);
  assert.match(source,/if\(\+\+processed>=4\)break/);
});

test('saving notes requests asynchronous indexing while keeping original data',()=>{
  assert.match(vite,/hayumeriSemanticMemoryApi\(\)/);
  assert.match(storage,/signalNotesChanged\(\)/);
  assert.match(source,/setTimeout\(\(\)=>\{wake=null;void reconcile\(\);\},1800\)/);
  assert.match(source,/setInterval\(\(\)=>\{void reconcile\(\);\},30000\)/);
  assert.doesNotMatch(source,/unlinkSync\(workspaceFile\)|writeFileSync\(workspaceFile/);
});

test('memory UI exposes source-linked lookup and only actual status',()=>{
  assert.match(workspace,/function renderSemanticMemory\(\)/);
  assert.match(workspace,/\/api\/memory\/status/);
  assert.match(workspace,/\/api\/memory\/search/);
  assert.match(workspace,/data-action="open-memory-note"/);
  assert.match(workspace,/location\.hash='#notes'/);
  assert.match(workspace,/Смысловой поиск среди сохранённых заметок/);
  assert.match(source,/req\.headers\.origin/);
  assert.match(source,/x-hayumeri-action/);
});
