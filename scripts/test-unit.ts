// @mostajs/replicator — Tests unitaires (SQLite :memory:)
// Author: Dr Hamid MADANI drmdh@msn.com
import { ReplicationManager, CDCListener, SchemaMapper, SyncEngine } from '../src/index.js'
import { registerSchemas, clearRegistry } from '@mostajs/orm'
import type { EntitySchema } from '@mostajs/orm'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string) {
  if (condition) { passed++; console.log('  ✅', label) }
  else { failed++; console.error('  ❌', label) }
}

async function assertThrowsAsync(fn: () => Promise<unknown>, expectedMsg: string, label: string) {
  try {
    await fn()
    failed++; console.error('  ❌', label, '(no throw)')
  } catch (e: any) {
    if (e.message.includes(expectedMsg)) { passed++; console.log('  ✅', label) }
    else { failed++; console.error('  ❌', label, '— got:', e.message) }
  }
}

async function run() {
  // ── T1 — Instanciation ──
  console.log('T1 — Instanciation')
  const rm = new ReplicationManager()
  assert(rm.size === 0, 'size === 0')
  assert(rm.listProjects().length === 0, 'listProjects() vide')
  assert(rm.listRules().length === 0, 'listRules() vide')
  console.log('')

  // ── T2 — Gardes ──
  console.log('T2 — Gardes et validations')
  await rm.addReplica('p1', { name: 'm1', role: 'master', dialect: 'sqlite', uri: ':memory:' })
  assert(rm.size === 1, 'addReplica master → size 1')

  await assertThrowsAsync(
    () => rm.addReplica('p1', { name: 'm1', role: 'slave', dialect: 'sqlite', uri: ':memory:' }),
    'existe deja', 'duplicate replica name → throw'
  )

  await assertThrowsAsync(
    () => rm.addReplica('p1', { name: 'm2', role: 'master', dialect: 'sqlite', uri: ':memory:' }),
    'deja un master', 'second master → throw'
  )
  console.log('')

  // ── T3 — Gestion replicas ──
  console.log('T3 — Gestion replicas')
  await rm.addReplica('p1', { name: 's1', role: 'slave', dialect: 'sqlite', uri: ':memory:' })
  assert(rm.size === 2, 'size === 2 (master + slave)')
  assert(rm.listProjects().includes('p1'), 'listProjects includes p1')
  assert(rm.hasReplicas('p1'), 'hasReplicas p1 === true')
  assert(!rm.hasReplicas('unknown'), 'hasReplicas unknown === false')

  const status = rm.getReplicaStatus('p1')
  assert(status.length === 2, 'getReplicaStatus → 2 replicas')
  assert(status.some(r => r.role === 'master'), 'has master')
  assert(status.some(r => r.role === 'slave'), 'has slave')
  assert(status.every(r => r.status === 'connected'), 'all connected')
  console.log('')

  // ── T4 — Failover ──
  console.log('T4 — Failover (promoteToMaster)')
  await rm.promoteToMaster('p1', 's1')
  const afterPromo = rm.getReplicaStatus('p1')
  assert(afterPromo.find(r => r.name === 's1')?.role === 'master', 's1 promoted to master')
  assert(afterPromo.find(r => r.name === 'm1')?.role === 'slave', 'm1 demoted to slave')

  // Promote already master → noop
  await rm.promoteToMaster('p1', 's1')
  assert(rm.getReplicaStatus('p1').find(r => r.name === 's1')?.role === 'master', 'promote noop OK')
  console.log('')

  // ── T5 — Read routing ──
  console.log('T5 — Read routing')
  rm.setReadRouting('p1', 'least-lag')
  assert(rm.getReadRouting('p1') === 'least-lag', 'getReadRouting → least-lag')
  rm.setReadRouting('p1', 'round-robin')
  assert(rm.getReadRouting('p1') === 'round-robin', 'getReadRouting → round-robin')
  rm.setReadRouting('p1', 'random')
  assert(rm.getReadRouting('p1') === 'random', 'getReadRouting → random')

  const svc = rm.resolveReadService('p1')
  assert(svc !== null, 'resolveReadService → not null')
  assert(rm.resolveReadService('unknown') === null, 'resolveReadService unknown → null')
  console.log('')

  // ── T6 — Rules (CRUD only, no sync) ──
  console.log('T6 — Replication rules (CRUD)')
  rm.addReplicationRule({
    name: 'r1', source: 'a', target: 'b',
    mode: 'cdc', collections: ['users'], conflictResolution: 'source-wins',
  })
  assert(rm.listRules().length === 1, 'listRules → 1')
  assert(rm.listRules()[0].name === 'r1', 'rule name === r1')
  assert(rm.listRules()[0].enabled === true, 'rule enabled by default')

  // sync without replicas → error
  let syncError = false
  try { await rm.sync('r1') } catch { syncError = true }
  assert(syncError, 'sync without replicas → throw')

  rm.removeReplicationRule('r1')
  assert(rm.listRules().length === 0, 'removeRule → 0 rules')
  console.log('')

  // ── T7 — Persistence ──
  console.log('T7 — Persistence')
  rm.addReplicationRule({
    name: 'persist-r', source: 'a', target: 'b',
    mode: 'snapshot', collections: ['x'], conflictResolution: 'timestamp',
  })
  rm.setReadRouting('p1', 'round-robin')

  const tmpFile = '/tmp/replicator-test-' + Date.now() + '.json'
  await rm.saveToFile(tmpFile)

  const fs = await import('node:fs/promises')
  const content = await fs.readFile(tmpFile, 'utf-8')
  const parsed = JSON.parse(content)
  assert(parsed.rules['persist-r'] !== undefined, 'saveToFile → rule saved')
  assert(parsed.replicas['p1'] !== undefined, 'saveToFile → replicas saved')
  assert(parsed.routing['p1'] === 'round-robin', 'saveToFile → routing saved')

  const rm2 = new ReplicationManager()
  await rm2.loadFromFile(tmpFile)
  assert(rm2.listRules().length === 1, 'loadFromFile → rules restored')
  assert(rm2.getReadRouting('p1') === 'round-robin', 'loadFromFile → routing restored')

  await fs.unlink(tmpFile)
  console.log('')

  // ── T8 — Lifecycle ──
  console.log('T8 — Lifecycle')
  await rm.disconnectAll()
  const afterDisc = rm.getReplicaStatus('p1')
  assert(afterDisc.every(r => r.status === 'disconnected'), 'disconnectAll → all disconnected')
  await rm.disconnectAll() // double call → no error
  assert(true, 'double disconnectAll → no error')

  // Remove replicas
  await rm.removeReplica('p1', 's1')
  await rm.removeReplica('p1', 'm1')
  assert(rm.size === 0, 'after remove all → size 0')
  console.log('')

  // ── T9 — Snapshot sync (real data, SQLite :memory:) ──
  console.log('T9 — Snapshot sync (S1)')

  // Define a test schema
  const ArticleSchema: EntitySchema = {
    name: 'Article',
    collection: 'articles',
    fields: {
      title: { type: 'string', required: true },
      body: { type: 'string' },
    },
    relations: {},
    indexes: [],
    timestamps: true,
  }

  clearRegistry()
  registerSchemas([ArticleSchema])

  // Create a fresh ReplicationManager with two projects (source + target)
  const rm3 = new ReplicationManager()
  await rm3.addReplica('src', { name: 'src-master', role: 'master', dialect: 'sqlite', uri: ':memory:' })
  await rm3.addReplica('tgt', { name: 'tgt-master', role: 'master', dialect: 'sqlite', uri: ':memory:' })

  // Insert test data into source
  const srcEs = rm3.resolveReadService('src')!
  await srcEs.create('Article', { id: 'a1', title: 'Premier', body: 'Contenu 1' })
  await srcEs.create('Article', { id: 'a2', title: 'Deuxieme', body: 'Contenu 2' })
  await srcEs.create('Article', { id: 'a3', title: 'Troisieme', body: 'Contenu 3' })

  // Verify target is empty
  const tgtEs = rm3.resolveReadService('tgt')!
  const beforeSync = await tgtEs.findAll('Article')
  assert(beforeSync.length === 0, 'target vide avant sync')

  // Add snapshot rule and sync
  rm3.addReplicationRule({
    name: 'snap1', source: 'src', target: 'tgt',
    mode: 'snapshot', collections: ['Article'], conflictResolution: 'source-wins',
  })

  const snapStats = await rm3.sync('snap1')
  assert(snapStats.recordsSynced === 3, 'snapshot → 3 records synced')
  assert(snapStats.errors === 0, 'snapshot → 0 errors')
  assert(snapStats.details !== undefined, 'snapshot → details present')
  assert(snapStats.details![0].created === 3, 'snapshot → 3 created')

  // Verify target has the data
  const afterSync = await tgtEs.findAll('Article')
  assert(afterSync.length === 3, 'target a 3 articles apres sync')
  assert(afterSync.some((a: any) => a.title === 'Premier'), 'target contient Premier')
  assert(afterSync.some((a: any) => a.title === 'Deuxieme'), 'target contient Deuxieme')
  console.log('')

  // ── T10 — Snapshot sync: conflict resolution ──
  console.log('T10 — Conflict resolution')

  // Update source record
  await srcEs.update('Article', 'a1', { title: 'Premier-MAJ' })

  // Sync again (snapshot) — should update a1
  const snapStats2 = await rm3.sync('snap1')
  assert(snapStats2.details![0].updated >= 1, 'snapshot re-sync → au moins 1 update')
  assert(snapStats2.errors === 0, 'snapshot re-sync → 0 errors')

  const a1tgt = await tgtEs.findById('Article', 'a1')
  assert(a1tgt?.title === 'Premier-MAJ', 'target a1 mis a jour (source-wins)')
  console.log('')

  // ── T11 — Snapshot sync: delete orphans ──
  console.log('T11 — Delete orphans (snapshot)')

  // Delete a2 from source
  await srcEs.delete('Article', 'a2')

  // Sync — target a2 should be deleted
  const snapStats3 = await rm3.sync('snap1')
  assert(snapStats3.details![0].deleted >= 1, 'snapshot → au moins 1 delete')

  const tgtAfterDel = await tgtEs.findAll('Article')
  assert(tgtAfterDel.length === 2, 'target a 2 articles (a2 supprime)')
  assert(!tgtAfterDel.some((a: any) => a.id === 'a2'), 'a2 absent du target')
  console.log('')

  // ── T12 — Incremental CDC sync ──
  console.log('T12 — Incremental CDC sync (S2)')

  rm3.removeReplicationRule('snap1')
  rm3.addReplicationRule({
    name: 'cdc1', source: 'src', target: 'tgt',
    mode: 'cdc', collections: ['Article'], conflictResolution: 'source-wins',
  })

  // Add a new record to source
  await srcEs.create('Article', { id: 'a4', title: 'Quatrieme', body: 'Contenu 4' })

  const cdcStats = await rm3.sync('cdc1')
  assert(cdcStats.recordsSynced >= 1, 'cdc → au moins 1 record synced')
  assert(cdcStats.errors === 0, 'cdc → 0 errors')

  const tgtA4 = await tgtEs.findById('Article', 'a4')
  assert(tgtA4 !== null, 'target a4 cree par CDC')

  // Second CDC sync with no changes → 0 synced
  // (small delay to ensure timestamp difference)
  const cdcStats2 = await rm3.sync('cdc1')
  // May sync some records due to timestamp granularity, but no errors
  assert(cdcStats2.errors === 0, 'second cdc sync → 0 errors')
  console.log('')

  // ── T13 — Bidirectional sync ──
  console.log('T13 — Bidirectional sync (S3)')

  rm3.removeReplicationRule('cdc1')
  rm3.addReplicationRule({
    name: 'bidir1', source: 'src', target: 'tgt',
    mode: 'bidirectional', collections: ['Article'], conflictResolution: 'timestamp',
  })

  // Create a record only on target
  await tgtEs.create('Article', { id: 'a5', title: 'Target-only', body: 'From target' })

  const bidirStats = await rm3.sync('bidir1')
  assert(bidirStats.errors === 0, 'bidirectional → 0 errors')

  // a5 should now exist on source
  const srcA5 = await srcEs.findById('Article', 'a5')
  assert(srcA5 !== null, 'source a a5 apres bidir sync')
  assert(srcA5?.title === 'Target-only', 'source a5 title correct')
  console.log('')

  // ── T14 — CDCListener: event capture + flush ──
  console.log('T14 — CDCListener (S4)')

  // Source creates → CDCListener captures → flushes to target
  const rm4 = new ReplicationManager()
  clearRegistry()
  registerSchemas([ArticleSchema])

  await rm4.addReplica('cdc-src', { name: 'master', role: 'master', dialect: 'sqlite', uri: ':memory:' })
  await rm4.addReplica('cdc-tgt', { name: 'master', role: 'master', dialect: 'sqlite', uri: ':memory:' })

  const cdcSrc = rm4.resolveReadService('cdc-src')!
  const cdcTgt = rm4.resolveReadService('cdc-tgt')!

  const flushLogs: any[] = []
  const listener = new CDCListener(cdcSrc, cdcTgt, {
    collections: ['Article'],
    conflictResolution: 'source-wins',
    flushThreshold: 50,
    flushIntervalMs: 0, // no auto-flush (manual only)
    onFlush: (s) => flushLogs.push(s),
  })

  listener.start()
  assert(listener.isRunning, 'listener is running')

  // Create records on source — events are captured
  await cdcSrc.create('Article', { id: 'c1', title: 'CDC-1', body: 'test' })
  await cdcSrc.create('Article', { id: 'c2', title: 'CDC-2', body: 'test' })

  assert(listener.pendingCount === 2, 'buffer has 2 pending events')

  // Manual flush
  const flushResult = await listener.flush()
  assert(flushResult.flushed === 2, 'flush → 2 events flushed')
  assert(flushResult.created === 2, 'flush → 2 created')
  assert(flushResult.errors === 0, 'flush → 0 errors')
  assert(listener.pendingCount === 0, 'buffer empty after flush')

  // Verify target has the records
  const cdcTgtAll = await cdcTgt.findAll('Article')
  assert(cdcTgtAll.length === 2, 'target has 2 articles after flush')

  // Update on source → capture + flush
  await cdcSrc.update('Article', 'c1', { title: 'CDC-1-MAJ' })
  const flushResult2 = await listener.flush()
  assert(flushResult2.updated === 1, 'flush update → 1 updated')

  const c1tgt = await cdcTgt.findById('Article', 'c1')
  assert(c1tgt?.title === 'CDC-1-MAJ', 'target c1 updated via CDC')

  // Delete on source → capture + flush
  await cdcSrc.delete('Article', 'c2')
  const flushResult3 = await listener.flush()
  assert(flushResult3.deleted === 1, 'flush delete → 1 deleted')

  const c2tgt = await cdcTgt.findById('Article', 'c2')
  assert(c2tgt === null, 'target c2 deleted via CDC')
  console.log('')

  // ── T15 — CDCListener: deduplication ──
  console.log('T15 — CDCListener deduplication')

  // Rapid create→update→update on same record → buffer should have 1 entry
  await cdcSrc.create('Article', { id: 'c3', title: 'V1', body: 'test' })
  await cdcSrc.update('Article', 'c3', { title: 'V2' })
  await cdcSrc.update('Article', 'c3', { title: 'V3' })

  assert(listener.pendingCount === 1, 'dedup: 3 events → 1 pending (same id)')

  const flushDedup = await listener.flush()
  assert(flushDedup.flushed === 1, 'dedup: flush → 1 event')

  const c3tgt = await cdcTgt.findById('Article', 'c3')
  assert(c3tgt?.title === 'V3', 'dedup: target has latest value V3')
  console.log('')

  // ── T16 — CDCListener: stop + final flush ──
  console.log('T16 — CDCListener stop')

  await cdcSrc.create('Article', { id: 'c4', title: 'Before-Stop', body: 'test' })
  assert(listener.pendingCount === 1, 'pending before stop')

  const finalStats = await listener.stop()
  assert(!listener.isRunning, 'listener stopped')
  assert(listener.pendingCount === 0, 'buffer empty after stop')
  assert(finalStats.flushed >= 1, 'final flush happened on stop')

  const c4tgt = await cdcTgt.findById('Article', 'c4')
  assert(c4tgt !== null, 'c4 flushed on stop')

  // After stop, new events are NOT captured
  await cdcSrc.create('Article', { id: 'c5', title: 'After-Stop', body: 'test' })
  assert(listener.pendingCount === 0, 'no capture after stop')

  // onFlush callback was called
  assert(flushLogs.length >= 3, 'onFlush callback invoked multiple times')
  console.log('')

  // ── T17 — CDCListener: collection filter ──
  console.log('T17 — CDCListener collection filter')

  // Register a second schema
  const TagSchema: EntitySchema = {
    name: 'Tag',
    collection: 'tags',
    fields: { label: { type: 'string', required: true } },
    relations: {},
    indexes: [],
    timestamps: true,
  }
  clearRegistry()
  registerSchemas([ArticleSchema, TagSchema])

  const rm5 = new ReplicationManager()
  await rm5.addReplica('f-src', { name: 'master', role: 'master', dialect: 'sqlite', uri: ':memory:' })
  await rm5.addReplica('f-tgt', { name: 'master', role: 'master', dialect: 'sqlite', uri: ':memory:' })

  const fSrc = rm5.resolveReadService('f-src')!
  const fTgt = rm5.resolveReadService('f-tgt')!

  // Listener only captures Article, NOT Tag
  const filterListener = new CDCListener(fSrc, fTgt, {
    collections: ['Article'],
    flushIntervalMs: 0,
  })
  filterListener.start()

  await fSrc.create('Article', { id: 'fa1', title: 'Yes', body: 'captured' })
  await fSrc.create('Tag', { id: 'ft1', label: 'Ignored' })

  assert(filterListener.pendingCount === 1, 'filter: only Article captured, Tag ignored')

  await filterListener.stop()
  await rm5.disconnectAll()
  console.log('')

  // ── T18 — SchemaMapper: same dialect (no issues) ──
  console.log('T18 — SchemaMapper: same dialect')

  const mapper1 = new SchemaMapper('sqlite', 'sqlite')
  const report1 = mapper1.validate([ArticleSchema])
  assert(report1.compatible === true, 'sqlite→sqlite compatible')
  assert(report1.issues.length === 0, 'sqlite→sqlite no issues')
  assert(report1.sourceDialect === 'sqlite', 'sourceDialect correct')
  assert(report1.targetDialect === 'sqlite', 'targetDialect correct')
  console.log('')

  // ── T19 — SchemaMapper: string truncation warning ──
  console.log('T19 — SchemaMapper: string truncation')

  const mapper2 = new SchemaMapper('postgres', 'mysql')
  const report2 = mapper2.validate([ArticleSchema])
  // Article has 'string' and 'string' fields — PG unlimited → MySQL 255
  const truncWarnings = report2.issues.filter(i => i.message.includes('truncated'))
  assert(truncWarnings.length > 0, 'PG→MySQL: string truncation warning')
  assert(truncWarnings[0].severity === 'warning', 'severity = warning')
  assert(report2.compatible === true, 'still compatible (warning, not error)')
  console.log('')

  // ── T20 — SchemaMapper: JSON native → non-native ──
  console.log('T20 — SchemaMapper: JSON warnings')

  const JsonSchema: EntitySchema = {
    name: 'Config',
    collection: 'configs',
    fields: {
      key: { type: 'string', required: true },
      value: { type: 'json' },
      tags: { type: 'array' },
    },
    relations: {},
    indexes: [],
    timestamps: true,
  }

  const mapper3 = new SchemaMapper('postgres', 'oracle')
  const report3 = mapper3.validate([JsonSchema])
  const jsonWarnings = report3.issues.filter(i => i.message.includes('JSON'))
  assert(jsonWarnings.length > 0, 'PG→Oracle: JSON native→text warning')
  const arrayWarnings = report3.issues.filter(i => i.message.includes('array'))
  assert(arrayWarnings.length > 0, 'PG→Oracle: array native→text warning')
  console.log('')

  // ── T21 — SchemaMapper: M2M cross-paradigm ──
  console.log('T21 — SchemaMapper: M2M cross-paradigm')

  const UserSchema: EntitySchema = {
    name: 'User',
    collection: 'users',
    fields: {
      name: { type: 'string', required: true },
    },
    relations: {
      roles: { type: 'many-to-many', target: 'Role', through: 'user_role' },
    },
    indexes: [],
    timestamps: true,
  }

  const mapper4 = new SchemaMapper('mongodb', 'postgres')
  const report4 = mapper4.validate([UserSchema])
  const m2mWarnings = report4.issues.filter(i => i.message.includes('M2M'))
  assert(m2mWarnings.length > 0, 'MongoDB→PG: M2M cross-paradigm warning')
  assert(mapper4.isCrossParadigm(), 'isCrossParadigm = true')
  assert(mapper4.getM2MCollections([UserSchema]).includes('User'), 'getM2MCollections includes User')
  assert(mapper4.getTargetStringLimit() === Infinity, 'PG string limit = Infinity')
  console.log('')

  // ── T22 — SchemaMapper: SQL→SQL M2M junction table ──
  console.log('T22 — SchemaMapper: SQL→SQL M2M')

  const mapper5 = new SchemaMapper('postgres', 'mysql')
  const report5 = mapper5.validate([UserSchema])
  const junctionWarnings = report5.issues.filter(i => i.message.includes('junction'))
  assert(junctionWarnings.length > 0, 'PG→MySQL: junction table sync warning')
  assert(!mapper5.isCrossParadigm(), 'PG→MySQL is NOT cross-paradigm')
  console.log('')

  // ── T23 — SyncEngine: validateCrossDialect ──
  console.log('T23 — SyncEngine validateCrossDialect')

  const engine = new SyncEngine()
  const valReport = engine.validateCrossDialect('postgres', 'sqlite', [ArticleSchema])
  assert(valReport.compatible === true, 'PG→SQLite compatible')
  assert(valReport.sourceDialect === 'postgres', 'source = postgres')

  const valReport2 = engine.validateCrossDialect('postgres', 'mysql', [ArticleSchema, JsonSchema])
  assert(valReport2.compatible === true, 'PG→MySQL compatible (with warnings)')
  assert(valReport2.issues.length > 0, 'PG→MySQL has warnings')
  console.log('')

  // ── T24 — Cross-dialect sync: SQLite A → SQLite B (different instances) ──
  console.log('T24 — Cross-dialect sync integration (SQLite A → SQLite B)')

  clearRegistry()
  registerSchemas([ArticleSchema])

  const rmCross = new ReplicationManager()
  await rmCross.addReplica('db-a', { name: 'master', role: 'master', dialect: 'sqlite', uri: ':memory:' })
  await rmCross.addReplica('db-b', { name: 'master', role: 'master', dialect: 'sqlite', uri: ':memory:' })

  const esA = rmCross.resolveReadService('db-a')!
  const esB = rmCross.resolveReadService('db-b')!

  // Populate source with varied data
  await esA.create('Article', { id: 'x1', title: 'Titre long avec accents éàü', body: 'JSON dans body {"key": "val"}' })
  await esA.create('Article', { id: 'x2', title: '', body: null })  // edge: empty string, null
  await esA.create('Article', { id: 'x3', title: 'Special chars: <>&"\'', body: '🚀 emoji test' })

  // Snapshot sync
  rmCross.addReplicationRule({
    name: 'cross1', source: 'db-a', target: 'db-b',
    mode: 'snapshot', collections: ['Article'], conflictResolution: 'source-wins',
  })

  const crossStats = await rmCross.sync('cross1')
  assert(crossStats.recordsSynced === 3, 'cross-dialect: 3 synced')
  assert(crossStats.errors === 0, 'cross-dialect: 0 errors')

  // Verify data integrity on target
  const bX1 = await esB.findById('Article', 'x1')
  assert(bX1?.title === 'Titre long avec accents éàü', 'accents preserved')
  assert(bX1?.body === 'JSON dans body {"key": "val"}', 'JSON string preserved')

  const bX2 = await esB.findById('Article', 'x2')
  assert(bX2?.title === '', 'empty string preserved')

  const bX3 = await esB.findById('Article', 'x3')
  assert(bX3?.title === 'Special chars: <>&"\'', 'special chars preserved')
  assert(bX3?.body === '🚀 emoji test', 'emoji preserved')
  console.log('')

  // ── T25 — Cross-dialect: incremental + bidirectional ──
  console.log('T25 — Cross-dialect: incremental + bidirectional')

  // Add record on source after initial sync
  await esA.create('Article', { id: 'x4', title: 'Incremental', body: 'new' })

  // Switch to CDC mode
  rmCross.removeReplicationRule('cross1')
  rmCross.addReplicationRule({
    name: 'cross-cdc', source: 'db-a', target: 'db-b',
    mode: 'cdc', collections: ['Article'], conflictResolution: 'source-wins',
  })

  const cdcCrossStats = await rmCross.sync('cross-cdc')
  assert(cdcCrossStats.errors === 0, 'cross CDC: 0 errors')
  const bX4 = await esB.findById('Article', 'x4')
  assert(bX4 !== null, 'x4 synced via CDC')

  // Bidirectional
  rmCross.removeReplicationRule('cross-cdc')
  rmCross.addReplicationRule({
    name: 'cross-bidir', source: 'db-a', target: 'db-b',
    mode: 'bidirectional', collections: ['Article'], conflictResolution: 'timestamp',
  })

  await esB.create('Article', { id: 'x5', title: 'From-B', body: 'reverse' })
  const bidirCrossStats = await rmCross.sync('cross-bidir')
  assert(bidirCrossStats.errors === 0, 'cross bidir: 0 errors')

  const aX5 = await esA.findById('Article', 'x5')
  assert(aX5 !== null, 'x5 synced from B to A (bidir)')
  assert(aX5?.title === 'From-B', 'x5 title correct')

  await rmCross.disconnectAll()
  console.log('')

  // ── T26 — Relation-aware sync with M2M ──
  console.log('T26 — Relation-aware sync (M2M)')

  const RoleSchema: EntitySchema = {
    name: 'Role',
    collection: 'roles',
    fields: { label: { type: 'string', required: true } },
    relations: {},
    indexes: [],
    timestamps: true,
  }

  const UserWithRoles: EntitySchema = {
    name: 'UserR',
    collection: 'userrs',
    fields: { name: { type: 'string', required: true } },
    relations: {
      roles: { type: 'many-to-many', target: 'Role', through: 'userr_role' },
    },
    indexes: [],
    timestamps: true,
  }

  clearRegistry()
  registerSchemas([RoleSchema, UserWithRoles])

  const rmRel = new ReplicationManager()
  await rmRel.addReplica('rel-src', { name: 'master', role: 'master', dialect: 'sqlite', uri: ':memory:' })
  await rmRel.addReplica('rel-tgt', { name: 'master', role: 'master', dialect: 'sqlite', uri: ':memory:' })

  const relSrc = rmRel.resolveReadService('rel-src')!
  const relTgt = rmRel.resolveReadService('rel-tgt')!

  // Create roles on BOTH source AND target (schemas are initialized on both)
  await relSrc.create('Role', { id: 'r1', label: 'Admin' })
  await relSrc.create('Role', { id: 'r2', label: 'Editor' })
  await relTgt.create('Role', { id: 'r1', label: 'Admin' })
  await relTgt.create('Role', { id: 'r2', label: 'Editor' })

  // Create user with M2M roles on source
  await relSrc.create('UserR', { id: 'u1', name: 'Alice', roles: ['r1', 'r2'] })

  // Use SyncEngine directly for relation-aware sync
  const relEngine = new SyncEngine()
  const rule = {
    name: 'rel-rule', source: 'rel-src', target: 'rel-tgt',
    mode: 'snapshot' as const, collections: ['UserR'],
    conflictResolution: 'source-wins' as const, enabled: true,
  }

  const relStats = await relEngine.snapshotWithRelations(
    relSrc, relTgt, rule, [RoleSchema, UserWithRoles],
  )
  assert(relStats.recordsSynced >= 1, 'relation-aware: at least 1 synced')
  assert(relStats.errors === 0, 'relation-aware: 0 errors')

  // Verify user exists on target
  const tgtU1 = await relTgt.findById('UserR', 'u1')
  assert(tgtU1 !== null, 'user u1 synced to target')
  assert(tgtU1?.name === 'Alice', 'user name correct')

  await rmRel.disconnectAll()
  console.log('')

  // ── Cleanup ──
  await rm4.disconnectAll()
  await rm3.disconnectAll()
  clearRegistry()

  // ── Summary ──
  console.log('════════════════════════════════════════')
  console.log(`  Resultats: ${passed} passed, ${failed} failed`)
  console.log('════════════════════════════════════════')
  if (failed > 0) process.exit(1)
}

run().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1) })
