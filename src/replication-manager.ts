// @mostajs/replicator — ReplicationManager
// Master/slave CQRS, cross-dialect CDC, read routing, failover
// Author: Dr Hamid MADANI drmdh@msn.com

import { createIsolatedDialect, EntityService, registerSchemas } from '@mostajs/orm'
import type { IDialect, EntitySchema, ConnectionConfig } from '@mostajs/orm'
import type { ProjectManager } from '@mostajs/mproject'
import type {
  ReplicaConfig,
  ReplicaContext,
  ReplicaInfo,
  ReplicationRule,
  SyncStats,
  ReadRoutingStrategy,
  ReplicatorTreeFile,
} from './types.js'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Mask a URI for display (hide password) */
function maskUri(uri: string): string {
  return uri.replace(/:([^@:]+)@/, ':***@')
}

/**
 * ReplicationManager — orchestrates master/slave replicas and cross-dialect CDC.
 *
 * Each replica gets its own isolated IDialect + EntityService instance.
 * Integrates with @mostajs/mproject for project-aware routing.
 *
 * Phase 3 (CQRS) : addReplica, setReadRouting, promoteToMaster
 * Phase 4 (CDC)  : addReplicationRule, sync
 */
export class ReplicationManager {
  // projectName → replicaName → context
  private replicas = new Map<string, Map<string, ReplicaContext>>()
  private entityServices = new Map<string, Map<string, EntityService>>()
  private routing = new Map<string, ReadRoutingStrategy>()
  private rules = new Map<string, ReplicationRule>()
  private syncStats = new Map<string, SyncStats>()
  private persistPath: string | null = null
  private pm: ProjectManager | null

  constructor(pm?: ProjectManager) {
    this.pm = pm ?? null
  }

  // ══════════════════════════════════════════════════════════
  // Replica management (Phase 3 — CQRS)
  // ══════════════════════════════════════════════════════════

  /**
   * Add a replica (master or slave) to a project.
   */
  async addReplica(projectName: string, config: ReplicaConfig): Promise<void> {
    // Validate project exists in ProjectManager if available
    if (this.pm && !this.pm.hasProject(projectName)) {
      throw new Error(`Projet "${projectName}" introuvable dans ProjectManager`)
    }

    let projectReplicas = this.replicas.get(projectName)
    if (!projectReplicas) {
      projectReplicas = new Map()
      this.replicas.set(projectName, projectReplicas)
      this.entityServices.set(projectName, new Map())
    }

    if (projectReplicas.has(config.name)) {
      throw new Error(`Replica "${config.name}" existe deja dans le projet "${projectName}"`)
    }

    // Only one master per project
    if (config.role === 'master') {
      for (const [, ctx] of projectReplicas) {
        if (ctx.role === 'master') {
          throw new Error(`Le projet "${projectName}" a deja un master: "${ctx.name}"`)
        }
      }
    }

    // Get schemas from project or empty
    let schemas: EntitySchema[] = []
    if (this.pm) {
      const projectCtx = this.pm.getProject(projectName)
      if (projectCtx) {
        schemas = projectCtx.schemas
      }
    }

    const pool = config.pool ?? { min: 2, max: 20 }

    try {
      const connectionConfig: ConnectionConfig = {
        dialect: config.dialect as ConnectionConfig['dialect'],
        uri: config.uri,
        schemaStrategy: config.schemaStrategy ?? 'update',
        poolSize: pool.max,
      }

      const dialect = await createIsolatedDialect(connectionConfig, schemas)
      const entityService = new EntityService(dialect)

      const ctx: ReplicaContext = {
        name: config.name,
        role: config.role,
        dialect,
        dialectType: config.dialect,
        schemas,
        pool,
        status: 'connected',
        uriMasked: maskUri(config.uri),
        lag: config.role === 'slave' ? 0 : undefined,
      }

      projectReplicas.set(config.name, ctx)
      this.entityServices.get(projectName)!.set(config.name, entityService)

      this.syncStats.set(`${projectName}/${config.name}`, {
        ruleName: `${projectName}/${config.name}`,
        lastSync: null,
        recordsSynced: 0,
        errors: 0,
        duration: 0,
      })

      await this.autoPersist()
    } catch (err) {
      // Store errored replica for visibility
      const projectReps = this.replicas.get(projectName)
      if (projectReps) {
        projectReps.set(config.name, {
          name: config.name,
          role: config.role,
          dialect: null as unknown as IDialect,
          dialectType: config.dialect,
          schemas: [],
          pool,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          uriMasked: maskUri(config.uri),
        })
      }
      throw err
    }
  }

  /**
   * Remove a replica from a project.
   */
  async removeReplica(projectName: string, replicaName: string): Promise<void> {
    const projectReplicas = this.replicas.get(projectName)
    if (!projectReplicas) {
      throw new Error(`Projet "${projectName}" n'a pas de replicas`)
    }

    const ctx = projectReplicas.get(replicaName)
    if (!ctx) {
      throw new Error(`Replica "${replicaName}" introuvable dans "${projectName}"`)
    }

    if (ctx.dialect && ctx.status === 'connected') {
      try { await ctx.dialect.disconnect() } catch { /* ignore */ }
    }

    projectReplicas.delete(replicaName)
    this.entityServices.get(projectName)?.delete(replicaName)
    this.syncStats.delete(`${projectName}/${replicaName}`)

    if (projectReplicas.size === 0) {
      this.replicas.delete(projectName)
      this.entityServices.delete(projectName)
    }

    await this.autoPersist()
  }

  /**
   * Set read routing strategy for a project.
   */
  setReadRouting(projectName: string, strategy: ReadRoutingStrategy): void {
    this.routing.set(projectName, strategy)
  }

  /**
   * Get read routing strategy for a project.
   */
  getReadRouting(projectName: string): ReadRoutingStrategy {
    return this.routing.get(projectName) ?? 'round-robin'
  }

  /**
   * Get replica status for a project.
   */
  getReplicaStatus(projectName: string): ReplicaInfo[] {
    const projectReplicas = this.replicas.get(projectName)
    if (!projectReplicas) return []

    return Array.from(projectReplicas.values()).map(ctx => ({
      name: ctx.name,
      role: ctx.role,
      dialect: ctx.dialectType,
      status: ctx.status,
      lag: ctx.lag,
      schemasCount: ctx.schemas.length,
      poolMax: ctx.pool.max,
      error: ctx.error,
    }))
  }

  /**
   * Promote a slave to master (failover).
   * The current master becomes a slave.
   */
  async promoteToMaster(projectName: string, replicaName: string): Promise<void> {
    const projectReplicas = this.replicas.get(projectName)
    if (!projectReplicas) {
      throw new Error(`Projet "${projectName}" n'a pas de replicas`)
    }

    const target = projectReplicas.get(replicaName)
    if (!target) {
      throw new Error(`Replica "${replicaName}" introuvable dans "${projectName}"`)
    }

    if (target.role === 'master') {
      return // already master
    }

    if (target.status !== 'connected') {
      throw new Error(`Replica "${replicaName}" n'est pas connectee (status: ${target.status})`)
    }

    // Demote current master to slave
    for (const [, ctx] of projectReplicas) {
      if (ctx.role === 'master') {
        ctx.role = 'slave'
        ctx.lag = 0
        break
      }
    }

    // Promote target to master
    target.role = 'master'
    target.lag = undefined

    await this.autoPersist()
  }

  /**
   * Resolve an EntityService for reading (uses routing strategy).
   */
  resolveReadService(projectName: string): EntityService | null {
    const projectServices = this.entityServices.get(projectName)
    const projectReplicas = this.replicas.get(projectName)
    if (!projectServices || !projectReplicas) return null

    const slaves = Array.from(projectReplicas.entries())
      .filter(([, ctx]) => ctx.role === 'slave' && ctx.status === 'connected')

    if (slaves.length === 0) {
      // Fallback to master
      const master = Array.from(projectReplicas.entries())
        .find(([, ctx]) => ctx.role === 'master' && ctx.status === 'connected')
      if (!master) return null
      return projectServices.get(master[0]) ?? null
    }

    const strategy = this.getReadRouting(projectName)
    let selected: string

    switch (strategy) {
      case 'least-lag': {
        const sorted = slaves.sort((a, b) => (a[1].lag ?? Infinity) - (b[1].lag ?? Infinity))
        selected = sorted[0][0]
        break
      }
      case 'random': {
        selected = slaves[Math.floor(Math.random() * slaves.length)][0]
        break
      }
      case 'round-robin':
      default: {
        // Simple: pick first slave (a real round-robin would track state)
        selected = slaves[0][0]
        break
      }
    }

    return projectServices.get(selected) ?? null
  }

  // ══════════════════════════════════════════════════════════
  // Replication rules (Phase 4 — CDC)
  // ══════════════════════════════════════════════════════════

  /**
   * Add a cross-dialect replication rule.
   */
  addReplicationRule(rule: Omit<ReplicationRule, 'enabled'> & { enabled?: boolean }): void {
    if (this.rules.has(rule.name)) {
      throw new Error(`Regle de replication "${rule.name}" existe deja`)
    }

    const fullRule: ReplicationRule = {
      ...rule,
      enabled: rule.enabled ?? true,
    }

    this.rules.set(rule.name, fullRule)
  }

  /**
   * Remove a replication rule.
   */
  removeReplicationRule(ruleName: string): void {
    if (!this.rules.has(ruleName)) {
      throw new Error(`Regle "${ruleName}" introuvable`)
    }
    this.rules.delete(ruleName)
    this.syncStats.delete(ruleName)
  }

  /**
   * List all replication rules.
   */
  listRules(): ReplicationRule[] {
    return Array.from(this.rules.values())
  }

  /**
   * Manual sync trigger for a replication rule.
   * Phase 4 implementation — placeholder for now.
   */
  async sync(ruleName: string): Promise<SyncStats> {
    const rule = this.rules.get(ruleName)
    if (!rule) {
      throw new Error(`Regle "${ruleName}" introuvable`)
    }

    if (!rule.enabled) {
      throw new Error(`Regle "${ruleName}" est desactivee`)
    }

    const start = Date.now()

    // TODO Phase 4: implement actual CDC sync logic
    // 1. Read source entities (rule.collections) from source project
    // 2. Compare with target (by ID or timestamp)
    // 3. Apply changes to target using conflict resolution strategy
    // 4. Track stats

    const stats: SyncStats = {
      ruleName,
      lastSync: new Date(),
      recordsSynced: 0,
      errors: 0,
      duration: Date.now() - start,
    }

    this.syncStats.set(ruleName, stats)
    return stats
  }

  /**
   * Get sync stats for a rule.
   */
  getSyncStats(ruleName: string): SyncStats | undefined {
    return this.syncStats.get(ruleName)
  }

  // ══════════════════════════════════════════════════════════
  // Persistence
  // ══════════════════════════════════════════════════════════

  enableAutoPersist(path: string): void {
    this.persistPath = resolve(path)
  }

  private async autoPersist(): Promise<void> {
    if (!this.persistPath) return
    try {
      await this.saveToFile(this.persistPath)
    } catch (err) {
      console.error('[replicator] Auto-persist failed:', err instanceof Error ? err.message : err)
    }
  }

  async saveToFile(path: string): Promise<void> {
    const tree: ReplicatorTreeFile = {
      replicas: {},
      rules: {},
      routing: {},
    }

    for (const [projectName, projectReplicas] of this.replicas) {
      tree.replicas[projectName] = {}
      for (const [replicaName, ctx] of projectReplicas) {
        tree.replicas[projectName][replicaName] = {
          role: ctx.role,
          dialect: ctx.dialectType,
          uri: ctx.uriMasked, // save masked URI for safety
          pool: ctx.pool,
        }
      }
    }

    for (const [name, rule] of this.rules) {
      const { name: _name, ...rest } = rule
      tree.rules[name] = rest
    }

    for (const [project, strategy] of this.routing) {
      tree.routing[project] = strategy
    }

    await writeFile(resolve(path), JSON.stringify(tree, null, 2), 'utf-8')
  }

  async loadFromFile(path: string): Promise<void> {
    const content = await readFile(resolve(path), 'utf-8')
    const tree: ReplicatorTreeFile = JSON.parse(content)

    // Restore routing
    if (tree.routing) {
      for (const [project, strategy] of Object.entries(tree.routing)) {
        this.routing.set(project, strategy)
      }
    }

    // Restore rules
    if (tree.rules) {
      for (const [name, rule] of Object.entries(tree.rules)) {
        if (!this.rules.has(name)) {
          this.rules.set(name, { name, ...rule })
        }
      }
    }

    // Note: replicas are NOT auto-reconnected from file
    // (URIs are masked for safety). Use addReplica() to reconnect.
  }

  // ══════════════════════════════════════════════════════════
  // Listing & info
  // ══════════════════════════════════════════════════════════

  /**
   * List all projects that have replicas.
   */
  listProjects(): string[] {
    return Array.from(this.replicas.keys())
  }

  /**
   * Check if a project has replicas.
   */
  hasReplicas(projectName: string): boolean {
    const projectReplicas = this.replicas.get(projectName)
    return projectReplicas ? projectReplicas.size > 0 : false
  }

  /**
   * Total number of replicas across all projects.
   */
  get size(): number {
    let total = 0
    for (const projectReplicas of this.replicas.values()) {
      total += projectReplicas.size
    }
    return total
  }

  // ══════════════════════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════════════════════

  /**
   * Disconnect all replicas across all projects.
   */
  async disconnectAll(): Promise<void> {
    for (const [, projectReplicas] of this.replicas) {
      for (const [, ctx] of projectReplicas) {
        if (ctx.dialect && ctx.status === 'connected') {
          try { await ctx.dialect.disconnect() } catch { /* ignore */ }
          ctx.status = 'disconnected'
        }
      }
    }
  }
}
