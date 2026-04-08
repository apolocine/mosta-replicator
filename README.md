# @mostajs/replicator

> Replication manager for @mostajs — master/slave CQRS, cross-dialect CDC, read routing, failover.

## Install

```bash
npm install @mostajs/replicator @mostajs/orm @mostajs/mproject
```

## Usage

```typescript
import { ReplicationManager } from '@mostajs/replicator'
import { ProjectManager } from '@mostajs/mproject'

const pm = new ProjectManager()
const replicator = new ReplicationManager(pm)

// Phase 3 — CQRS: add replicas to a project
await replicator.addReplica('secuaccess', {
  name: 'master',
  role: 'master',
  dialect: 'postgres',
  uri: 'postgresql://user:pass@master:5432/secuaccess',
})

await replicator.addReplica('secuaccess', {
  name: 'slave-1',
  role: 'slave',
  dialect: 'postgres',
  uri: 'postgresql://user:pass@slave1:5432/secuaccess',
  lagTolerance: 5000,
})

// Read routing
replicator.setReadRouting('secuaccess', 'least-lag')
const readService = replicator.resolveReadService('secuaccess')

// Status
replicator.getReplicaStatus('secuaccess')
// → [{ role: 'master', lag: 0 }, { role: 'slave', lag: 120 }]

// Failover
await replicator.promoteToMaster('secuaccess', 'slave-1')

// Phase 4 — Cross-dialect CDC
replicator.addReplicationRule({
  name: 'pg-to-mongo',
  source: 'secuaccess',
  target: 'analytics',
  mode: 'cdc',
  collections: ['users', 'clients'],
  conflictResolution: 'source-wins',
})

await replicator.sync('pg-to-mongo')

// Persistence
replicator.enableAutoPersist('replicator-tree.json')

// Cleanup
await replicator.disconnectAll()
```

## API

| Method | Phase | Description |
|---|---|---|
| `addReplica(project, config)` | 3 | Add master or slave to a project |
| `removeReplica(project, name)` | 3 | Disconnect and remove replica |
| `setReadRouting(project, strategy)` | 3 | Set routing: round-robin, least-lag, random |
| `getReplicaStatus(project)` | 3 | List replicas with status and lag |
| `promoteToMaster(project, name)` | 3 | Failover: promote slave to master |
| `resolveReadService(project)` | 3 | Get EntityService for reading (routed) |
| `addReplicationRule(rule)` | 4 | Add cross-dialect CDC rule |
| `removeReplicationRule(name)` | 4 | Remove a rule |
| `listRules()` | 4 | List all replication rules |
| `sync(ruleName)` | 4 | Manual sync trigger |
| `getSyncStats(ruleName)` | 4 | Get sync statistics |
| `loadFromFile(path)` | — | Load config from JSON |
| `saveToFile(path)` | — | Save config to JSON |
| `enableAutoPersist(path)` | — | Auto-save after changes |
| `disconnectAll()` | — | Clean shutdown |

## License

AGPL-3.0-or-later — (c) 2026 Dr Hamid MADANI <drmdh@msn.com>
