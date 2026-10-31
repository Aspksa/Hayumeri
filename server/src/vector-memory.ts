import { createHash } from 'node:crypto';
import type { QdrantClient } from '@qdrant/js-client-rest';

export type MemoryKind = 'note' | 'document' | 'conversation' | 'fact' | 'agent';
export interface MemoryChunk {
  namespace: string;
  sourceId: string;
  chunkId: string;
  kind: MemoryKind;
  vector: number[];
  sourceHash: string;
  revision: string;
  preview?: string;
  recordedAt: string;
}
export interface MemoryHit {
  id: string;
  score: number;
  namespace: string;
  sourceId: string;
  chunkId: string;
  kind: MemoryKind;
  sourceHash: string;
  revision: string;
  preview?: string;
  recordedAt: string;
}
const tag = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/;
const kinds = new Set<MemoryKind>(['note','document','conversation','fact','agent']);

/** Qdrant is an index, not the source of truth. Original documents live elsewhere.
 * Embeddings MUST come from a real, separately configured model. This module
 * intentionally does not invent embeddings from text or silently use a cloud API.
 */
export class VectorMemory {
  readonly collection: string;
  private readonly modelId: string;
  private readonly dimension: number;
  private readonly client: QdrantClient;
  private initialized: Promise<void> | null = null;

  constructor(client: QdrantClient, { modelId, dimension }: { modelId: string; dimension: number }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(modelId)) throw new Error('Invalid embedding model ID');
    if (!Number.isInteger(dimension) || dimension < 8 || dimension > 8192) {
      throw new Error('Invalid embedding dimension');
    }
    this.client = client;
    this.modelId = modelId;
    this.dimension = dimension;
    const modelKey = createHash('sha256').update(modelId, 'utf8').digest('hex').slice(0, 20);
    this.collection = 'hayumeri_memory_v1_' + modelKey + '_d' + dimension;
  }

  private validateTag(value: string, field: string): void {
    if (!tag.test(value)) throw new Error('Invalid ' + field);
  }
  private validateVector(vector: number[]): void {
    if (!Array.isArray(vector) || vector.length !== this.dimension ||
        vector.some(value => typeof value !== 'number' || !Number.isFinite(value)) ||
        !vector.some(value => value !== 0)) {
      throw new Error('Invalid embedding vector; expected ' + this.dimension + ' finite non-zero dimensions');
    }
  }
  private idOf(input: Pick<MemoryChunk,'namespace'|'sourceId'|'chunkId'>): string {
    const hash = createHash('sha256').update(JSON.stringify([
      this.modelId, this.dimension, input.namespace, input.sourceId, input.chunkId
    ])).digest('hex');
    // Qdrant IDs are positive integers or RFC4122 UUIDs. Derive an
    // idempotent UUID-like ID without exposing content or user identifiers.
    return hash.slice(0,8) + '-' + hash.slice(8,12) + '-5' + hash.slice(13,16)
      + '-a' + hash.slice(17,20) + '-' + hash.slice(20,32);
  }
  private async ensureCollection(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = this.initialize().catch(error => {
      this.initialized = null; // retry on transient Qdrant outage
      throw error;
    });
    return this.initialized;
  }
  private async initialize(): Promise<void> {
    const existing = await this.client.getCollections();
    if (!existing.collections.some(item => item.name === this.collection)) {
      try {
        await this.client.createCollection(this.collection, {
          vectors: { size: this.dimension, distance: 'Cosine', on_disk: true },
          hnsw_config: { on_disk: true },
          on_disk_payload: true
        });
      } catch (error) {
        // A second process may have created this collection concurrently.
        const current = await this.client.getCollections();
        if (!current.collections.some(item => item.name === this.collection)) throw error;
      }
    }
    const info = await this.client.getCollection(this.collection);
    const vectors = info.config.params.vectors;
    if (!vectors || typeof vectors !== 'object' ||
        !('size' in vectors) || vectors.size !== this.dimension ||
        !('distance' in vectors) || vectors.distance !== 'Cosine') {
      // Never recreate or resize a collection with user data.
      throw new Error('Incompatible existing Qdrant collection; data left untouched');
    }
  }
  private where(namespace: string, sourceId?: string) {
    this.validateTag(namespace, 'namespace');
    const must: Array<{key: string; match: {value: string}}> = [
      {key: 'namespace', match: {value: namespace}},
      {key: 'modelId', match: {value: this.modelId}}
    ];
    if (sourceId !== undefined) {
      this.validateTag(sourceId, 'sourceId');
      must.push({key: 'sourceId',match:{value:sourceId}});
    }
    return {must};
  }

  async remember(chunks: MemoryChunk[]): Promise<number> {
    if (!Array.isArray(chunks)) throw new Error('Expected memory chunks');
    if (!chunks.length) return 0;
    const ids = new Set<string>();
    for (const input of chunks) {
      this.validateTag(input.namespace,'namespace');
      this.validateTag(input.sourceId,'sourceId');
      this.validateTag(input.chunkId,'chunkId');
      if (!kinds.has(input.kind)) throw new Error('Invalid memory kind');
      if (!/^[a-f0-9]{64}$/.test(input.sourceHash)) throw new Error('Invalid source hash');
      this.validateTag(input.revision, 'revision');
      if (typeof input.recordedAt !== 'string' || !Number.isFinite(Date.parse(input.recordedAt))) {
        throw new Error('Invalid recorded date');
      }
      if (input.preview !== undefined && (typeof input.preview !== 'string' || input.preview.length > 350)) {
        throw new Error('Preview too large');
      }
      this.validateVector(input.vector);
      const id = this.idOf(input);
      if (ids.has(id)) throw new Error('Duplicate chunk in one batch');
      ids.add(id);
    }
    await this.ensureCollection();
    // Bounded request batches protect RAM; there is NO global count limit.
    for (let start = 0; start < chunks.length; start += 64) {
      const slice = chunks.slice(start, start + 64);
      await this.client.upsert(this.collection, { wait: true, points: slice.map(input => ({
        id: this.idOf(input),
        vector: input.vector,
        payload: {
          namespace: input.namespace, sourceId: input.sourceId, chunkId: input.chunkId,
          kind: input.kind, sourceHash: input.sourceHash, revision: input.revision,
          recordedAt: input.recordedAt, modelId: this.modelId,
          ...(input.preview !== undefined ? {preview:input.preview} : {})
        }
      }))});
    }
    return chunks.length;
  }

  async recall({namespace,vector,limit = 10,scoreThreshold = 0,sourceId}: {
    namespace: string;vector: number[];limit?: number;scoreThreshold?: number;sourceId?: string
  }): Promise<MemoryHit[]> {
    this.validateVector(vector);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid search page size');
    if (!Number.isFinite(scoreThreshold) || scoreThreshold < 0 || scoreThreshold > 1) {
      throw new Error('Invalid similarity threshold');
    }
    const filter = this.where(namespace, sourceId);
    await this.ensureCollection();
    const result = await this.client.query(this.collection, {
      query: vector, limit, filter,
      score_threshold: scoreThreshold, with_payload: true, with_vector: false
    });
    return result.points.map(point => {
      const p = point.payload ?? {};
      return {
        id: String(point.id), score: point.score ?? 0,
        namespace: String(p.namespace ?? ''),
        sourceId: String(p.sourceId ?? ''),
        chunkId: String(p.chunkId ?? ''),
        kind: (kinds.has(p.kind as MemoryKind) ? p.kind : 'fact') as MemoryKind,
        sourceHash: String(p.sourceHash ?? ''),
        revision: String(p.revision ?? ''),
        recordedAt: String(p.recordedAt ?? ''),
        ...(typeof p.preview === 'string' ? {preview:p.preview} : {})
      };
    });
  }
  async forgetSource(namespace: string, sourceId: string): Promise<void> {
    const filter = this.where(namespace,sourceId);
    await this.ensureCollection();
    await this.client.delete(this.collection, {wait: true, filter});
  }
  async count(namespace: string): Promise<number> {
    const filter = this.where(namespace);
    await this.ensureCollection();
    return (await this.client.count(this.collection, {filter, exact: true})).count;
  }
}
