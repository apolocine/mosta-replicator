// @mostajs/replicator — Replication manager for @mostajs
// Master/slave CQRS, cross-dialect CDC, read routing, failover
// Author: Dr Hamid MADANI drmdh@msn.com

export { ReplicationManager } from './replication-manager.js'

export type {
  ReplicaConfig,
  ReplicaContext,
  ReplicaInfo,
  ReplicationRule,
  ReplicationMode,
  ConflictResolution,
  SyncStats,
  ReadRoutingStrategy,
  ReplicatorTreeFile,
} from './types.js'
