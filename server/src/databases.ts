/**
 * Server-only adapters. NEVER import into the Vite/browser bundle.
 */
import { config as loadDotenv } from 'dotenv';
import { MongoClient } from 'mongodb';
import neo4j from 'neo4j-driver';
import { createClient } from 'redis';
import { QdrantClient } from '@qdrant/js-client-rest';
import { fileURLToPath } from 'node:url';

export type DatabaseName = 'mongodb' | 'redis' | 'neo4j' | 'qdrant';
export interface DatabaseSettings {
  mongoPassword: string;
  redisPassword: string;
  neo4jPassword: string;
  qdrantApiKey: string;
}
export interface DatabaseProbe {
  name: DatabaseName;
  ok: boolean;
  latencyMs: number;
  error?: string;
}
const secretKeys = ['MONGO_PASSWORD', 'REDIS_PASSWORD', 'NEO4J_PASSWORD', 'QDRANT_API_KEY'] as const;
const envPath = fileURLToPath(new URL('../../.env.nosql', import.meta.url));

export function loadSettings(): DatabaseSettings {
  loadDotenv({ path: envPath, quiet: true });
  const env = process.env;
  for (const key of secretKeys) {
    if (!/^[a-fA-F0-9]{64}$/.test(env[key] ?? '')) {
      throw new Error('Отсутствует или повреждён ' + key + ' в .env.nosql. Запустите Hayumeri-DB.bat start.');
    }
  }
  return {
    mongoPassword: env.MONGO_PASSWORD!,
    redisPassword: env.REDIS_PASSWORD!,
    neo4jPassword: env.NEO4J_PASSWORD!,
    qdrantApiKey: env.QDRANT_API_KEY!
  };
}

export function mongoClient(settings: DatabaseSettings): MongoClient {
  const password = encodeURIComponent(settings.mongoPassword);
  return new MongoClient('mongodb://hayumeri:' + password + '@127.0.0.1:27017/hayumeri?authSource=admin', {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 4000,
    maxPoolSize: 5
  });
}

export function redisClient(settings: DatabaseSettings) {
  const client = createClient({
    url: 'redis://:' + encodeURIComponent(settings.redisPassword) + '@127.0.0.1:6379',
    socket: { connectTimeout: 5000, reconnectStrategy: false }
  });
  client.on('error', () => { /* prevent unhandled error events; callers handle connect failures */ });
  return client;
}

export function graphClient(settings: DatabaseSettings) {
  return neo4j.driver(
    'bolt://127.0.0.1:7687',
    neo4j.auth.basic('neo4j', settings.neo4jPassword),
    { connectionTimeout: 5000, maxConnectionPoolSize: 5 }
  );
}

export function vectorClient(settings: DatabaseSettings): QdrantClient {
  return new QdrantClient({
    url: 'http://127.0.0.1:6333',
    apiKey: settings.qdrantApiKey,
    checkCompatibility: false
  });
}

async function check(name: DatabaseName, task: () => Promise<void>): Promise<DatabaseProbe> {
  const start = performance.now();
  try {
    await task();
    return { name, ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (error) {
    // Do not print raw driver errors: URLs can contain secrets.
    const message = error instanceof Error ? error.name : 'UnknownError';
    return { name, ok: false, latencyMs: Math.round(performance.now() - start), error: message };
  }
}

export async function probeDatabases(settings: DatabaseSettings): Promise<DatabaseProbe[]> {
  const probes = [
    check('mongodb', async () => {
      const client = mongoClient(settings);
      try {
        await client.connect();
        await client.db('admin').command({ ping: 1 });
      } finally { await client.close(); }
    }),
    check('redis', async () => {
      const client = redisClient(settings);
      try {
        await client.connect();
        if (await client.ping() !== 'PONG') throw new Error('Redis ping failed');
      } finally { client.destroy(); }
    }),
    check('neo4j', async () => {
      const driver = graphClient(settings);
      try {
        await driver.verifyConnectivity();
        const session = driver.session();
        try {
          const result = await session.run('RETURN 1 AS ok');
          if (result.records[0]?.get('ok') !== 1) throw new Error('Cypher check failed');
        } finally { await session.close(); }
      } finally { await driver.close(); }
    }),
    check('qdrant', async () => {
      const client = vectorClient(settings);
      const result = await client.getCollections();
      if (!Array.isArray(result.collections)) throw new Error('Qdrant response is invalid');
    })
  ];
  return Promise.all(probes);
}
