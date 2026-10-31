import { createHash, randomUUID } from 'node:crypto';
import { loadSettings, vectorClient } from './databases.ts';
import { VectorMemory, type MemoryChunk } from './vector-memory.ts';

// Real integration: no artificial vectors stored outside an isolated CI
// collection; never touches the user's vector memory or source documents.
async function main(): Promise<void> {
  const client = vectorClient(loadSettings());
  const modelId = 'ci_vector_' + randomUUID().replaceAll('-', '');
  const memory = new VectorMemory(client, { modelId, dimension: 8 });
  const sourceId = 'sample_' + randomUUID().replaceAll('-', '');
  const base = {
    sourceId,
    kind: 'document' as const,
    revision: 'rev1',
    sourceHash: createHash('sha256').update('CI temporary data').digest('hex'),
    recordedAt: new Date().toISOString()
  };
  const chunks: MemoryChunk[] = [
    { ...base, namespace: 'private_a', chunkId: 'part1', preview: 'Временный фрагмент для теста',
      vector: [0.8,0.2,0,0,0,0,0,0] },
    { ...base, namespace: 'private_a', chunkId: 'part2', preview: 'Другой временный фрагмент',
      vector: [0,0,0,0.8,0.2,0,0,0] },
    { ...base, namespace: 'private_b', chunkId: 'part1', preview: 'Изолированная память',
      vector: [0.8,0.2,0,0,0,0,0,0] }
  ];
  let created = false;
  try {
    await memory.remember(chunks);
    created = true;
    if (await memory.count('private_a') !== 2) throw new Error('Vector memory count failed');
    if (await memory.count('private_b') !== 1) throw new Error('Vector memory namespace isolation failed');
    const hits = await memory.recall({
      namespace: 'private_a', vector: [0.8,0.2,0,0,0,0,0,0], limit: 2,
      scoreThreshold: 0.2
    });
    if (!hits.length || hits[0]?.chunkId !== 'part1' || hits[0]?.sourceId !== sourceId ||
        hits[0]?.sourceHash !== base.sourceHash) {
      throw new Error('Vector recall rank or source traceability failed');
    }
    if (hits.some(hit => hit.namespace !== 'private_a')) throw new Error('Cross-namespace vector leak');
    await memory.remember([{...chunks[0]!, revision: 'rev2'}]);
    if (await memory.count('private_a') !== 2) throw new Error('Idempotent memory update duplicated a point');
    const scoped = await memory.recall({
      namespace:'private_a',sourceId, vector:[0.8,0.2,0,0,0,0,0,0],limit:2
    });
    if (scoped[0]?.revision !== 'rev2') throw new Error('Latest source revision not returned');
    await memory.forgetSource('private_a', sourceId);
    if (await memory.count('private_a') !== 0 || await memory.count('private_b') !== 1) {
      throw new Error('Scoped forgetting removed data outside its namespace');
    }
    console.log('[OK] Qdrant: disk-backed memory, retrieval, source IDs, revision and isolation');
  } finally {
    if (created) {
      // Delete ONLY the random CI-created collection.
      await client.deleteCollection(memory.collection);
    }
  }
}
main().catch(error => {
  console.error('[ОШИБКА] Векторная память: ' + (error instanceof Error ? error.name : 'UnknownError'));
  process.exitCode = 1;
}).finally(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});
