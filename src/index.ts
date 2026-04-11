// @mostajs/replicator — Replication manager for @mostajs
// Master/slave CQRS, cross-dialect CDC, read routing, failover
// Author: Dr Hamid MADANI drmdh@msn.com

export { ReplicationManager } from './replication-manager.js'
export { SyncEngine } from './sync-engine.js'
export { CDCListener } from './cdc-listener.js'
export { SchemaMapper } from './schema-mapper.js'

export type {
  ReplicaConfig,
  ReplicaContext,
  ReplicaInfo,
  ReplicationRule,
  ReplicationMode,
  ConflictResolution,
  SyncStats,
  SyncCollectionStats,
  ChangeRecord,
  SyncCursor,
  ReadRoutingStrategy,
  ReplicatorTreeFile,
} from './types.js'

export type {
  CDCEvent,
  CDCListenerConfig,
  CDCFlushStats,
} from './cdc-listener.js'

export type {
  CompatSeverity,
  CompatIssue,
  CompatReport,
} from './schema-mapper.js'
