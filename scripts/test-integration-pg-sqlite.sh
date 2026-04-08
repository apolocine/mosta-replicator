#!/bin/bash
# @mostajs/replicator — Test integration PostgreSQL master + SQLite slave
# Author: Dr Hamid MADANI drmdh@msn.com
# Prerequis: PostgreSQL sur localhost:5432
# Usage: bash scripts/test-integration-pg-sqlite.sh
set -e

cd "$(dirname "$0")/.."
echo ""
echo "════════════════════════════════════════════════════"
echo "  @mostajs/replicator — Integration PG + SQLite"
echo "════════════════════════════════════════════════════"
echo ""

PG_URI="${PG_URI:-postgresql://devuser:devpass26@localhost:5432/test_replicator}"

echo "▶ PostgreSQL URI: $PG_URI"
echo "▶ Build..."
npx tsc 2>&1
echo "  ✅ Build OK"
echo ""

npx tsx -e "
import { ReplicationManager } from './src/index.js'
import { registerSchemas } from '@mostajs/orm'

const schemas = [{
  name: 'Item',
  collection: 'items',
  timestamps: true,
  fields: {
    title: { type: 'string', required: true },
    value: { type: 'number', default: 0 },
  },
  relations: {},
  indexes: [],
}]

registerSchemas(schemas)

async function run() {
  const rm = new ReplicationManager()

  console.log('T9.1 — addReplica master (postgres)')
  await rm.addReplica('test', {
    name: 'master',
    role: 'master',
    dialect: 'postgres',
    uri: '${PG_URI}',
    pool: { min: 1, max: 5 },
    schemaStrategy: 'create',
  })
  console.log('  ✅ Master connected')

  console.log('T9.2 — addReplica slave (sqlite)')
  await rm.addReplica('test', {
    name: 'slave',
    role: 'slave',
    dialect: 'sqlite',
    uri: ':memory:',
    schemaStrategy: 'create',
  })
  console.log('  ✅ Slave connected')

  console.log('T9.3 — getReplicaStatus')
  const status = rm.getReplicaStatus('test')
  console.log('  Replicas:', status.map(r => r.name + '(' + r.role + ':' + r.status + ')').join(', '))

  console.log('T9.4 — resolveReadService')
  rm.setReadRouting('test', 'round-robin')
  const svc = rm.resolveReadService('test')
  console.log('  ✅ Read service resolved:', svc !== null)

  console.log('T9.5 — promoteToMaster (slave)')
  await rm.promoteToMaster('test', 'slave')
  const after = rm.getReplicaStatus('test')
  console.log('  Slave role:', after.find(r => r.name === 'slave')?.role)
  console.log('  Master role:', after.find(r => r.name === 'master')?.role)

  console.log('')
  console.log('T9.6 — disconnectAll')
  await rm.disconnectAll()
  console.log('  ✅ All disconnected')

  console.log('')
  console.log('════════════════════════════════════════════════════')
  console.log('  Integration PG+SQLite : OK')
  console.log('════════════════════════════════════════════════════')
}

run().catch(e => { console.error('❌', e.message); process.exit(1) })
"
