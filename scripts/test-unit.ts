// @mostajs/replicator — Tests unitaires (SQLite :memory:)
// Author: Dr Hamid MADANI drmdh@msn.com
import { ReplicationManager } from '../src/index.js'

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

  // ── T6 — Rules ──
  console.log('T6 — Replication rules')
  rm.addReplicationRule({
    name: 'r1', source: 'a', target: 'b',
    mode: 'cdc', collections: ['users'], conflictResolution: 'source-wins',
  })
  assert(rm.listRules().length === 1, 'listRules → 1')
  assert(rm.listRules()[0].name === 'r1', 'rule name === r1')
  assert(rm.listRules()[0].enabled === true, 'rule enabled by default')

  const syncStats = await rm.sync('r1')
  assert(syncStats.recordsSynced === 0, 'sync → 0 records (placeholder)')
  assert(syncStats.errors === 0, 'sync → 0 errors')
  assert(syncStats.lastSync !== null, 'sync → lastSync set')

  const saved = rm.getSyncStats('r1')
  assert(saved?.lastSync !== null, 'getSyncStats → lastSync')

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

  // ── Summary ──
  console.log('════════════════════════════════════════')
  console.log(`  Resultats: ${passed} passed, ${failed} failed`)
  console.log('════════════════════════════════════════')
  if (failed > 0) process.exit(1)
}

run().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1) })
