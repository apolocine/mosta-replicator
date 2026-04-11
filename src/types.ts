// @mostajs/replicator — Types
// Author: Dr Hamid MADANI drmdh@msn.com

import type { IDialect, EntitySchema, ConnectionConfig } from '@mostajs/orm'

// ══════════════════════════════════════════════════════════
// Read routing
// ══════════════════════════════════════════════════════════

export type ReadRoutingStrategy = 'round-robin' | 'least-lag' | 'random'

// ══════════════════════════════════════════════════════════
// Replica (intra-projet CQRS — Phase 3)
// ══════════════════════════════════════════════════════════

export interface ReplicaConfig {
  /** Unique name for this replica */
  name: string
  /** Role in the CQRS topology */
  role: 'master' | 'slave'
  /** Dialect type (postgres, mongodb, etc.) */
  dialect: string
  /** Connection URI */
  uri: string
  /** Connection pool config */
  pool?: { min: number; max: number }
  /** Schema strategy for this replica */
  schemaStrategy?: ConnectionConfig['schemaStrategy']
  /** Acceptable replication lag in ms (slaves only) */
  lagTolerance?: number
}

export interface ReplicaContext {
  name: string
  role: 'master' | 'slave'
  dialect: IDialect
  dialectType: string
  schemas: EntitySchema[]
  pool: { min: number; max: number }
  status: 'connected' | 'disconnected' | 'error'
  error?: string
  uriMasked: string
  /** Last measured lag in ms (slaves only) */
  lag?: number
}

export interface ReplicaInfo {
  name: string
  role: 'master' | 'slave'
  dialect: string
  status: string
  lag?: number
  schemasCount: number
  poolMax: number
  error?: string
}

// ══════════════════════════════════════════════════════════
// Replication rules (cross-dialect CDC — Phase 4)
// ══════════════════════════════════════════════════════════

export type ConflictResolution = 'source-wins' | 'target-wins' | 'timestamp'
export type ReplicationMode = 'snapshot' | 'cdc' | 'bidirectional'

export interface ReplicationRule {
  /** Unique rule name */
  name: string
  /** Source project name */
  source: string
  /** Target project name */
  target: string
  /** Replication mode */
  mode: ReplicationMode
  /** Entity names to replicate */
  collections: string[]
  /** Conflict resolution strategy */
  conflictResolution: ConflictResolution
  /** Whether this rule is active */
  enabled: boolean
}

// ══════════════════════════════════════════════════════════
// Sync stats & context
// ══════════════════════════════════════════════════════════

export interface SyncStats {
  ruleName: string
  lastSync: Date | null
  recordsSynced: number
  errors: number
  /** Duration in ms */
  duration: number
  /** Breakdown per collection */
  details?: SyncCollectionStats[]
}

export interface SyncCollectionStats {
  collection: string
  created: number
  updated: number
  deleted: number
  skipped: number
  errors: number
}

/** Internal record for change tracking during sync */
export interface ChangeRecord {
  id: string
  collection: string
  op: 'create' | 'update' | 'delete' | 'skip'
  data?: Record<string, unknown>
  error?: string
}

/** Cursor for incremental CDC sync */
export interface SyncCursor {
  ruleName: string
  /** Last sync timestamp per collection */
  cursors: Record<string, Date>
}

// ══════════════════════════════════════════════════════════
// Persistence format
// ══════════════════════════════════════════════════════════

export interface ReplicatorTreeFile {
  replicas: Record<string, Record<string, Omit<ReplicaConfig, 'name'>>>
  rules: Record<string, Omit<ReplicationRule, 'name'>>
  routing: Record<string, ReadRoutingStrategy>
}
