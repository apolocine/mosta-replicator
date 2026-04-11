// @mostajs/replicator — SyncEngine
// Snapshot, incremental CDC, and bidirectional sync logic
// Author: Dr Hamid MADANI drmdh@msn.com

import type { EntityService, EntitySchema } from '@mostajs/orm'
import type {
  ReplicationRule,
  ConflictResolution,
  SyncStats,
  SyncCollectionStats,
  ChangeRecord,
  SyncCursor,
} from './types.js'
import { SchemaMapper } from './schema-mapper.js'
import type { CompatReport } from './schema-mapper.js'

/** Batch size for paginated reads during sync */
const BATCH_SIZE = 500

/**
 * SyncEngine — executes replication sync between two EntityServices.
 *
 * Modes:
 * - snapshot : full mirror source → target (create/update/delete)
 * - cdc      : incremental delta via updatedAt > cursor (Phase S2)
 * - bidirectional : two-way merge with timestamp conflict resolution (Phase S3)
 */
export class SyncEngine {

  // ══════════════════════════════════════════════════════════
  // S1 — Snapshot sync
  // ══════════════════════════════════════════════════════════

  /**
   * Full snapshot sync: mirror source → target for all collections in the rule.
   * - Records in source but not target → create
   * - Records in both → conflict resolution decides update or skip
   * - Records in target but not source → delete (full mirror)
   */
  async snapshot(
    source: EntityService,
    target: EntityService,
    rule: ReplicationRule,
  ): Promise<SyncStats> {
    const start = Date.now()
    const details: SyncCollectionStats[] = []
    let totalSynced = 0
    let totalErrors = 0

    for (const collection of rule.collections) {
      const stats = await this.syncCollection(
        source, target, collection, rule.conflictResolution, true,
      )
      details.push(stats)
      totalSynced += stats.created + stats.updated + stats.deleted
      totalErrors += stats.errors
    }

    return {
      ruleName: rule.name,
      lastSync: new Date(),
      recordsSynced: totalSynced,
      errors: totalErrors,
      duration: Date.now() - start,
      details,
    }
  }

  // ══════════════════════════════════════════════════════════
  // S2 — Incremental CDC sync (delta via updatedAt)
  // ══════════════════════════════════════════════════════════

  /**
   * Incremental sync: only records modified since last cursor.
   * Does NOT delete target-only records (unlike snapshot).
   */
  async incremental(
    source: EntityService,
    target: EntityService,
    rule: ReplicationRule,
    cursor: SyncCursor,
  ): Promise<{ stats: SyncStats; newCursor: SyncCursor }> {
    const start = Date.now()
    const details: SyncCollectionStats[] = []
    let totalSynced = 0
    let totalErrors = 0
    const newCursors: Record<string, Date> = {}

    for (const collection of rule.collections) {
      const since = cursor.cursors[collection] ?? new Date(0)
      const stats = await this.syncCollectionIncremental(
        source, target, collection, rule.conflictResolution, since,
      )
      details.push(stats)
      totalSynced += stats.created + stats.updated
      totalErrors += stats.errors
      newCursors[collection] = new Date()
    }

    return {
      stats: {
        ruleName: rule.name,
        lastSync: new Date(),
        recordsSynced: totalSynced,
        errors: totalErrors,
        duration: Date.now() - start,
        details,
      },
      newCursor: { ruleName: rule.name, cursors: newCursors },
    }
  }

  // ══════════════════════════════════════════════════════════
  // S3 — Bidirectional sync
  // ══════════════════════════════════════════════════════════

  /**
   * Bidirectional sync: both sides push changes to each other.
   * Conflict resolution = timestamp (updatedAt wins).
   */
  async bidirectional(
    source: EntityService,
    target: EntityService,
    rule: ReplicationRule,
  ): Promise<SyncStats> {
    const start = Date.now()
    const details: SyncCollectionStats[] = []
    let totalSynced = 0
    let totalErrors = 0

    for (const collection of rule.collections) {
      // Source → Target (no delete, conflict = timestamp)
      const s2t = await this.syncCollection(
        source, target, collection, 'timestamp', false,
      )
      // Target → Source (no delete, conflict = timestamp)
      const t2s = await this.syncCollection(
        target, source, collection, 'timestamp', false,
      )

      const merged: SyncCollectionStats = {
        collection,
        created: s2t.created + t2s.created,
        updated: s2t.updated + t2s.updated,
        deleted: 0,
        skipped: s2t.skipped + t2s.skipped,
        errors: s2t.errors + t2s.errors,
      }
      details.push(merged)
      totalSynced += merged.created + merged.updated
      totalErrors += merged.errors
    }

    return {
      ruleName: rule.name,
      lastSync: new Date(),
      recordsSynced: totalSynced,
      errors: totalErrors,
      duration: Date.now() - start,
      details,
    }
  }

  // ══════════════════════════════════════════════════════════
  // Internal — collection-level sync
  // ══════════════════════════════════════════════════════════

  /**
   * Sync a single collection: full scan source → target.
   * @param deleteOrphans - if true, delete target records not in source (snapshot mode)
   */
  private async syncCollection(
    source: EntityService,
    target: EntityService,
    collection: string,
    conflictResolution: ConflictResolution,
    deleteOrphans: boolean,
  ): Promise<SyncCollectionStats> {
    const stats: SyncCollectionStats = {
      collection, created: 0, updated: 0, deleted: 0, skipped: 0, errors: 0,
    }

    try {
      // Read all source records (paginated)
      const sourceRecords = await this.readAll(source, collection)

      // Build target index by ID for fast lookup
      const targetRecords = await this.readAll(target, collection)
      const targetIndex = new Map<string, Record<string, unknown>>()
      for (const rec of targetRecords) {
        targetIndex.set(rec.id as string, rec)
      }

      // Track which target IDs were matched
      const matchedTargetIds = new Set<string>()

      // Process source records
      for (const srcRec of sourceRecords) {
        const id = srcRec.id as string
        const targetRec = targetIndex.get(id)

        if (!targetRec) {
          // Record exists in source but not target → create
          const change = await this.applyCreate(target, collection, srcRec)
          if (change.op === 'create') stats.created++
          else stats.errors++
        } else {
          matchedTargetIds.add(id)
          // Record exists in both → apply conflict resolution
          const change = await this.applyConflictResolution(
            target, collection, id, srcRec, targetRec, conflictResolution,
          )
          if (change.op === 'update') stats.updated++
          else if (change.op === 'skip') stats.skipped++
          else stats.errors++
        }
      }

      // Delete orphans (target records not in source) — snapshot mode only
      if (deleteOrphans) {
        for (const [id] of targetIndex) {
          if (!matchedTargetIds.has(id) && !sourceRecords.some(r => (r.id as string) === id)) {
            const change = await this.applyDelete(target, collection, id)
            if (change.op === 'delete') stats.deleted++
            else stats.errors++
          }
        }
      }
    } catch (err) {
      stats.errors++
    }

    return stats
  }

  /**
   * Incremental sync for a single collection: only records with updatedAt > since.
   */
  private async syncCollectionIncremental(
    source: EntityService,
    target: EntityService,
    collection: string,
    conflictResolution: ConflictResolution,
    since: Date,
  ): Promise<SyncCollectionStats> {
    const stats: SyncCollectionStats = {
      collection, created: 0, updated: 0, deleted: 0, skipped: 0, errors: 0,
    }

    try {
      // Only fetch records updated after the cursor
      const filter = { updatedAt: { $gt: since.toISOString() } }
      const sourceRecords = await source.findAll(collection, filter)

      for (const srcRec of sourceRecords) {
        const id = srcRec.id as string
        let targetRec: Record<string, unknown> | null = null

        try {
          targetRec = await target.findById(collection, id)
        } catch { /* not found */ }

        if (!targetRec) {
          const change = await this.applyCreate(target, collection, srcRec)
          if (change.op === 'create') stats.created++
          else stats.errors++
        } else {
          const change = await this.applyConflictResolution(
            target, collection, id, srcRec, targetRec, conflictResolution,
          )
          if (change.op === 'update') stats.updated++
          else if (change.op === 'skip') stats.skipped++
          else stats.errors++
        }
      }

      // Detect deletes: records with deletedAt > since (soft-delete)
      try {
        const deletedFilter = { deletedAt: { $gt: since.toISOString() } }
        const deletedRecords = await source.findAll(collection, deletedFilter)
        for (const rec of deletedRecords) {
          const change = await this.applyDelete(target, collection, rec.id as string)
          if (change.op === 'delete') stats.deleted++
          else stats.errors++
        }
      } catch {
        // Collection may not have soft-delete — ignore
      }
    } catch (err) {
      stats.errors++
    }

    return stats
  }

  // ══════════════════════════════════════════════════════════
  // Internal — record-level operations
  // ══════════════════════════════════════════════════════════

  /** Read all records from a collection with pagination */
  private async readAll(
    es: EntityService,
    collection: string,
  ): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = []
    let offset = 0

    while (true) {
      const batch = await es.findAll(collection, {}, {
        limit: BATCH_SIZE,
        skip: offset,
        sort: { id: 1 },
      })
      if (batch.length === 0) break
      all.push(...batch)
      if (batch.length < BATCH_SIZE) break
      offset += BATCH_SIZE
    }

    return all
  }

  /** Create a record on target, stripping ORM metadata */
  private async applyCreate(
    target: EntityService,
    collection: string,
    srcRec: Record<string, unknown>,
  ): Promise<ChangeRecord> {
    try {
      const data = this.stripMeta(srcRec)
      await target.create(collection, data)
      return { id: srcRec.id as string, collection, op: 'create' }
    } catch (err) {
      return {
        id: srcRec.id as string, collection, op: 'skip',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** Delete a record on target */
  private async applyDelete(
    target: EntityService,
    collection: string,
    id: string,
  ): Promise<ChangeRecord> {
    try {
      await target.delete(collection, id)
      return { id, collection, op: 'delete' }
    } catch (err) {
      return {
        id, collection, op: 'skip',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** Apply conflict resolution between source and target records */
  private async applyConflictResolution(
    target: EntityService,
    collection: string,
    id: string,
    srcRec: Record<string, unknown>,
    targetRec: Record<string, unknown>,
    strategy: ConflictResolution,
  ): Promise<ChangeRecord> {
    switch (strategy) {
      case 'source-wins': {
        // Always overwrite target with source
        return this.applyUpdate(target, collection, id, srcRec)
      }

      case 'target-wins': {
        // Keep target — skip
        return { id, collection, op: 'skip' }
      }

      case 'timestamp': {
        const srcTime = this.getTimestamp(srcRec)
        const tgtTime = this.getTimestamp(targetRec)
        if (srcTime > tgtTime) {
          return this.applyUpdate(target, collection, id, srcRec)
        }
        return { id, collection, op: 'skip' }
      }

      default:
        return { id, collection, op: 'skip' }
    }
  }

  /** Update a record on target */
  private async applyUpdate(
    target: EntityService,
    collection: string,
    id: string,
    srcRec: Record<string, unknown>,
  ): Promise<ChangeRecord> {
    try {
      const data = this.stripMeta(srcRec)
      await target.update(collection, id, data)
      return { id, collection, op: 'update' }
    } catch (err) {
      return {
        id, collection, op: 'skip',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // Cross-dialect validation
  // ══════════════════════════════════════════════════════════

  /**
   * Validate cross-dialect compatibility before running sync.
   * Returns a report with warnings and errors.
   */
  validateCrossDialect(
    sourceDialect: string,
    targetDialect: string,
    schemas: EntitySchema[],
  ): CompatReport {
    const mapper = new SchemaMapper(sourceDialect, targetDialect)
    return mapper.validate(schemas)
  }

  // ══════════════════════════════════════════════════════════
  // Relation-aware sync
  // ══════════════════════════════════════════════════════════

  /**
   * Snapshot sync with M2M relation support.
   * Reads source records WITH relations, writes to target WITH relation data.
   */
  async snapshotWithRelations(
    source: EntityService,
    target: EntityService,
    rule: ReplicationRule,
    schemas: EntitySchema[],
  ): Promise<SyncStats> {
    const start = Date.now()
    const details: SyncCollectionStats[] = []
    let totalSynced = 0
    let totalErrors = 0

    for (const collection of rule.collections) {
      const schema = schemas.find(s => s.name === collection)
      const m2mRelations = schema
        ? Object.entries(schema.relations)
            .filter(([, r]) => r.type === 'many-to-many' || r.type === 'one-to-many')
            .map(([name]) => name)
        : []

      const stats = await this.syncCollectionWithRelations(
        source, target, collection, rule.conflictResolution, true, m2mRelations,
      )
      details.push(stats)
      totalSynced += stats.created + stats.updated + stats.deleted
      totalErrors += stats.errors
    }

    return {
      ruleName: rule.name,
      lastSync: new Date(),
      recordsSynced: totalSynced,
      errors: totalErrors,
      duration: Date.now() - start,
      details,
    }
  }

  /**
   * Sync a collection including its M2M/O2M relations.
   */
  private async syncCollectionWithRelations(
    source: EntityService,
    target: EntityService,
    collection: string,
    conflictResolution: ConflictResolution,
    deleteOrphans: boolean,
    relations: string[],
  ): Promise<SyncCollectionStats> {
    const stats: SyncCollectionStats = {
      collection, created: 0, updated: 0, deleted: 0, skipped: 0, errors: 0,
    }

    try {
      // Read source with relations populated
      const sourceRecords = relations.length > 0
        ? await this.readAllWithRelations(source, collection, relations)
        : await this.readAll(source, collection)

      const targetRecords = await this.readAll(target, collection)
      const targetIndex = new Map<string, Record<string, unknown>>()
      for (const rec of targetRecords) {
        targetIndex.set(rec.id as string, rec)
      }

      const matchedTargetIds = new Set<string>()

      for (const srcRec of sourceRecords) {
        const id = srcRec.id as string
        const targetRec = targetIndex.get(id)

        // Extract relation IDs from populated objects
        const data = this.extractRelationIds(srcRec, relations)

        if (!targetRec) {
          const change = await this.applyCreate(target, collection, data)
          if (change.op === 'create') stats.created++
          else stats.errors++
        } else {
          matchedTargetIds.add(id)
          const change = await this.applyConflictResolution(
            target, collection, id, data, targetRec, conflictResolution,
          )
          if (change.op === 'update') stats.updated++
          else if (change.op === 'skip') stats.skipped++
          else stats.errors++
        }
      }

      if (deleteOrphans) {
        for (const [id] of targetIndex) {
          if (!matchedTargetIds.has(id) && !sourceRecords.some(r => (r.id as string) === id)) {
            const change = await this.applyDelete(target, collection, id)
            if (change.op === 'delete') stats.deleted++
            else stats.errors++
          }
        }
      }
    } catch {
      stats.errors++
    }

    return stats
  }

  /** Read all records with relations populated */
  private async readAllWithRelations(
    es: EntityService,
    collection: string,
    relations: string[],
  ): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = []
    let offset = 0

    while (true) {
      const repo = es.getRepo(collection)
      const batch = await repo.findWithRelations({}, relations, {
        limit: BATCH_SIZE,
        skip: offset,
        sort: { id: 1 },
      })
      if (batch.length === 0) break
      all.push(...batch)
      if (batch.length < BATCH_SIZE) break
      offset += BATCH_SIZE
    }

    return all
  }

  /**
   * Extract relation IDs from populated objects.
   * Turns populated objects [{id: 'x', name: '...'}, ...] into ID arrays ['x', ...]
   * so the target dialect can handle M2M insertion in its own way.
   */
  private extractRelationIds(
    rec: Record<string, unknown>,
    relations: string[],
  ): Record<string, unknown> {
    const result = { ...rec }

    for (const relName of relations) {
      const val = result[relName]
      if (Array.isArray(val)) {
        // Convert populated objects to ID array
        result[relName] = val.map(item => {
          if (typeof item === 'object' && item !== null && 'id' in item) {
            return (item as Record<string, unknown>).id
          }
          return item // already an ID
        })
      }
    }

    return result
  }

  // ══════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════

  /** Strip ORM-managed fields before writing to target */
  private stripMeta(rec: Record<string, unknown>): Record<string, unknown> {
    const { createdAt, updatedAt, deletedAt, ...data } = rec
    return data
  }

  /** Extract updatedAt timestamp as epoch ms (fallback to 0) */
  private getTimestamp(rec: Record<string, unknown>): number {
    const ts = rec.updatedAt ?? rec.createdAt
    if (!ts) return 0
    if (ts instanceof Date) return ts.getTime()
    const parsed = Date.parse(String(ts))
    return isNaN(parsed) ? 0 : parsed
  }
}
