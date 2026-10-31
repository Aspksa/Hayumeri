import { randomUUID } from 'node:crypto';
import { loadSettings, mongoClient, redisClient, graphClient, vectorClient } from './databases.ts';

// Deliberate, isolated CRUD test; never touches user collections or graph nodes.
async function main(): Promise<void> {
  const settings = loadSettings();
  const id = randomUUID();
  const mongo = mongoClient(settings);
  try {
    await mongo.connect();
    const collection = mongo.db('hayumeri').collection<{ _id: string; value: string }>('hayumeri_smoke');
    try {
      await collection.insertOne({ _id: id, value: 'ok' });
      if (!(await collection.findOne({ _id: id }))) throw new Error('MongoDB read failed');
    } finally { await collection.deleteOne({ _id: id }); }
    console.log('[OK] MongoDB: запись/чтение/очистка');
  } finally { await mongo.close(); }

  const redis = redisClient(settings);
  const key = 'hayumeri:smoke:' + id;
  try {
    await redis.connect();
    try {
      await redis.set(key, 'ok', { EX: 60 });
      if (await redis.get(key) !== 'ok') throw new Error('Redis read failed');
    } finally { if (redis.isOpen) await redis.del(key); }
    console.log('[OK] Redis: запись/чтение/очистка');
  } finally { redis.destroy(); }

  const graph = graphClient(settings);
  try {
    const session = graph.session();
    try {
      try {
        await session.run('CREATE (n:HayumeriSmoke {id: $id})', { id });
        const result = await session.run('MATCH (n:HayumeriSmoke {id: $id}) RETURN n.id AS id', { id });
        if (result.records[0]?.get('id') !== id) throw new Error('Neo4j read failed');
      } finally {
        await session.run('MATCH (n:HayumeriSmoke {id: $id}) DETACH DELETE n', { id });
      }
      console.log('[OK] Neo4j: запись/чтение/очистка');
    } finally { await session.close(); }
  } finally { await graph.close(); }

  const vectors = vectorClient(settings);
  const collection = 'hayumeri_smoke_' + id.replaceAll('-', '_');
  let created = false;
  try {
    await vectors.createCollection(collection, { vectors: { size: 4, distance: 'Cosine' } });
    created = true;
    await vectors.upsert(collection, { wait: true, points: [{ id: 1, vector: [0.1, 0.2, 0.3, 0.4] }] });
    const got = await vectors.retrieve(collection, { ids: [1] });
    if (got.length !== 1) throw new Error('Qdrant read failed');
    console.log('[OK] Qdrant: запись/чтение/очистка');
  } finally {
    if (created) await vectors.deleteCollection(collection);
  }
}

main().catch(error => {
  console.error('[ОШИБКА] Проверка записи не прошла: ' + (error instanceof Error ? error.name : 'UnknownError'));
  process.exitCode = 1;
});
