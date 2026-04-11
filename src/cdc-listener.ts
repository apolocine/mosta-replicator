// @mostajs/replicator — CDCListener
// Event-based Change Data Capture: hooks EntityService events → queue → batch flush
// Author: Dr Hamid MADANI drmdh@msn.com

import type { EntityService } from '@mostajs/orm'
import type { ConflictResolution, SyncCollectionStats } from './types.js'

// ══════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════

export interface CDCEvent {
  op: 'create' | 'update' | 'delete'
  collection: string
  id: string
  data?: Record<string, unknown>
  timestamp: number
}

export interface CDCListenerConfig {
  /** Collections to capture (empty = all) */
  collections?: string[]
  /** Conflict resolution when applying to target */
  conflictResolution?: ConflictResolution
  /** Flush buffer when it reaches this size (default: 100) */
  flushThreshold?: number
  /** Auto-flush interval in ms (default: 5000, 0 = disabled) */
  flushIntervalMs?: number
  /** Called on each flush with stats */
  onFlush?: (stats: CDCFlushStats) => void
  /** Called on error during flush */
  onError?: (err: Error, event: CDCEvent) => void
}

export interface CDCFlushStats {
  flushed: number
  created: number
  updated: number
  deleted: number
  errors: number
  duration: number
}

// ══════════════════════════════════════════════════════════
// CDCListener
// ══════════════════════════════════════════════════════════

/**
 * CDCListener — captures entity events from a source EntityService,
 * buffers them, and flushes in batch to a target EntityService.
 *
 * Events are deduplicated per (collection, id): only the latest operation
 * per record is kept in the buffer. This prevents redundant writes on
 * rapid create→update or update→update sequences.
 *
 * Usage:
 *   const listener = new CDCListener(sourceEs, targetEs, { collections: ['Article'] })
 *   listener.start()
 *   // ... source operations happen, changes are captured and flushed ...
 *   await listener.stop()
 */
export class CDCListener {
  private source: EntityService
  private target: EntityService
  private config: Required<Omit<CDCListenerConfig, 'onFlush' | 'onError'>> & Pick<CDCListenerConfig, 'onFlush' | 'onError'>
  private buffer = new Map<string, CDCEvent>()  // key = "collection:id"
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private flushing = false
  private totalStats: CDCFlushStats = { flushed: 0, created: 0, updated: 0, deleted: 0, errors: 0, duration: 0 }

  // Bound handlers for cleanup
  private handleCreated: (ev: any) => void
  private handleUpdated: (ev: any) => void
  private handleDeleted: (ev: any) => void

  constructor(source: EntityService, target: EntityService, config?: CDCListenerConfig) {
    this.source = source
    this.target = target
    this.config = {
      collections: config?.collections ?? [],
      conflictResolution: config?.conflictResolution ?? 'source-wins',
      flushThreshold: config?.flushThreshold ?? 100,
      flushIntervalMs: config?.flushIntervalMs ?? 5000,
      onFlush: config?.onFlush,
      onError: config?.onError,
    }

    this.handleCreated = (ev) => this.capture('create', ev)
    this.handleUpdated = (ev) => this.capture('update', ev)
    this.handleDeleted = (ev) => this.capture('delete', ev)
  }

  // ══════════════════════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════════════════════

  /** Start listening for entity events on the source */
  start(): void {
    if (this.running) return
    this.running = true

    this.source.on('entity.created', this.handleCreated)
    this.source.on('entity.updated', this.handleUpdated)
    this.source.on('entity.deleted', this.handleDeleted)

    if (this.config.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch(() => {})
      }, this.config.flushIntervalMs)
    }
  }

  /** Stop listening and flush remaining buffer */
  async stop(): Promise<CDCFlushStats> {
    if (!this.running) return this.totalStats
    this.running = false

    this.source.off('entity.created', this.handleCreated)
    this.source.off('entity.updated', this.handleUpdated)
    this.source.off('entity.deleted', this.handleDeleted)

    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    // Final flush
    await this.flush()
    return this.totalStats
  }

  /** Check if the listener is active */
  get isRunning(): boolean {
    return this.running
  }

  /** Number of events pending in the buffer */
  get pendingCount(): number {
    return this.buffer.size
  }

  /** Cumulative stats since start */
  get stats(): CDCFlushStats {
    return { ...this.totalStats }
  }

  // ══════════════════════════════════════════════════════════
  // Event capture
  // ══════════════════════════════════════════════════════════

  private capture(op: CDCEvent['op'], ev: { entity: string; id?: string; data?: any }): void {
    const collection = ev.entity
    if (!this.shouldCapture(collection)) return

    const id = op === 'delete' ? ev.id! : (ev.data?.id ?? ev.id)
    if (!id) return

    const key = `${collection}:${id}`

    // Deduplicate: latest event per (collection, id) wins
    this.buffer.set(key, {
      op,
      collection,
      id: String(id),
      data: op !== 'delete' ? ev.data : undefined,
      timestamp: Date.now(),
    })

    // Auto-flush on threshold
    if (this.buffer.size >= this.config.flushThreshold) {
      this.flush().catch(() => {})
    }
  }

  private shouldCapture(collection: string): boolean {
    if (this.config.collections.length === 0) return true
    return this.config.collections.includes(collection)
  }

  // ══════════════════════════════════════════════════════════
  // Flush buffer → target
  // ══════════════════════════════════════════════════════════

  /** Flush all buffered events to the target EntityService */
  async flush(): Promise<CDCFlushStats> {
    if (this.flushing || this.buffer.size === 0) {
      return { flushed: 0, created: 0, updated: 0, deleted: 0, errors: 0, duration: 0 }
    }

    this.flushing = true
    const start = Date.now()
    const stats: CDCFlushStats = { flushed: 0, created: 0, updated: 0, deleted: 0, errors: 0, duration: 0 }

    // Snapshot and clear buffer atomically
    const events = Array.from(this.buffer.values())
    this.buffer.clear()

    // Sort by timestamp (oldest first) for correct ordering
    events.sort((a, b) => a.timestamp - b.timestamp)

    for (const event of events) {
      try {
        await this.applyEvent(event)
        stats.flushed++
        switch (event.op) {
          case 'create': stats.created++; break
          case 'update': stats.updated++; break
          case 'delete': stats.deleted++; break
        }
      } catch (err) {
        stats.errors++
        this.config.onError?.(err instanceof Error ? err : new Error(String(err)), event)
      }
    }

    stats.duration = Date.now() - start
    this.flushing = false

    // Accumulate totals
    this.totalStats.flushed += stats.flushed
    this.totalStats.created += stats.created
    this.totalStats.updated += stats.updated
    this.totalStats.deleted += stats.deleted
    this.totalStats.errors += stats.errors
    this.totalStats.duration += stats.duration

    this.config.onFlush?.(stats)
    return stats
  }

  // ══════════════════════════════════════════════════════════
  // Apply single event to target
  // ══════════════════════════════════════════════════════════

  private async applyEvent(event: CDCEvent): Promise<void> {
    switch (event.op) {
      case 'create': {
        // Check if already exists on target
        const existing = await this.safeFindById(event.collection, event.id)
        if (existing) {
          // Already exists → apply conflict resolution
          if (this.config.conflictResolution === 'target-wins') return
          await this.target.update(event.collection, event.id, this.stripMeta(event.data!))
        } else {
          await this.target.create(event.collection, this.stripMeta(event.data!))
        }
        break
      }

      case 'update': {
        const existing = await this.safeFindById(event.collection, event.id)
        if (!existing) {
          // Target doesn't have it yet → create
          await this.target.create(event.collection, this.stripMeta(event.data!))
        } else if (this.config.conflictResolution === 'target-wins') {
          return
        } else if (this.config.conflictResolution === 'timestamp') {
          const srcTime = this.getTimestamp(event.data!)
          const tgtTime = this.getTimestamp(existing)
          if (srcTime <= tgtTime) return
          await this.target.update(event.collection, event.id, this.stripMeta(event.data!))
        } else {
          // source-wins
          await this.target.update(event.collection, event.id, this.stripMeta(event.data!))
        }
        break
      }

      case 'delete': {
        await this.target.delete(event.collection, event.id)
        break
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════

  private async safeFindById(collection: string, id: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.target.findById(collection, id)
    } catch {
      return null
    }
  }

  private stripMeta(rec: Record<string, unknown>): Record<string, unknown> {
    const { createdAt, updatedAt, deletedAt, ...data } = rec
    return data
  }

  private getTimestamp(rec: Record<string, unknown>): number {
    const ts = rec.updatedAt ?? rec.createdAt
    if (!ts) return 0
    if (ts instanceof Date) return ts.getTime()
    const parsed = Date.parse(String(ts))
    return isNaN(parsed) ? 0 : parsed
  }
}
