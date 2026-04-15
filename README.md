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

## Consistency model

`@mostajs/replicator` operates on three distinct levels of consistency. Knowing which level you're on avoids surprises under load or during failover.

### 1. Local transactions — ACID ✅

Every write against a single replica (master **or** slave) is ACID, delegated to the underlying `@mostajs/orm` dialect (see [`@mostajs/orm` → Transactions](https://github.com/apolocine/mosta-orm#transactions)). Wrap your operations in `$transaction` and you get `BEGIN` / `COMMIT` / `ROLLBACK` — identical semantics to using the SGBD directly.

```ts
const writeService = replicator.resolveWriteService('secuaccess')
await writeService.dialect.$transaction(async (tx) => {
  await tx.update('accounts', { id: 'a' }, { $inc: { balance: -50 } })
  await tx.update('accounts', { id: 'b' }, { $inc: { balance:  50 } })
})
```

### 2. Master → slave replication — eventual consistency (default)

By design, slaves are updated **asynchronously** from the master. A successful commit on the master is visible on the master **immediately** and on the slaves **after some lag** (typically milliseconds, bounded by `lagTolerance`). This is the standard CQRS trade-off : fast writes, scalable reads, eventual convergence.

**Implications** :
- Read-your-own-writes is only guaranteed when routing to the master.
- `read-routing: 'least-lag'` picks the freshest slave but does not eliminate lag.
- `promoteToMaster()` during failover may lose in-flight writes that didn't replicate in time — set `lagTolerance: 0` on critical replicas to block promotion if behind.

### 3. Cross-dialect CDC rules — eventual + idempotent

`addReplicationRule({ mode: 'cdc', source, target })` captures changes on one dialect (e.g. PostgreSQL) and replays them on another (e.g. MongoDB). This is **eventually consistent** with at-least-once delivery. Rules must be **idempotent** (use `upsert` on target) — the replicator does not provide distributed ACID across heterogeneous engines.

**Use CDC for** : analytics mirrors, search indexes, audit trails, cross-region read replicas.
**Do not use CDC for** : financial transactions spanning two engines, inventory decrements across systems, anything needing rollback across dialects. For those, keep the transactional boundary inside a single dialect.

### Cheat sheet

| You need… | Use |
|---|---|
| Atomic multi-row write on one SGBD | Local `$transaction` (level 1) |
| Scale reads of a single project | Master + slaves (level 2) |
| Survive a node crash | `promoteToMaster()` + `lagTolerance: 0` |
| Mirror PG → Mongo / Elasticsearch | `addReplicationRule({ mode: 'cdc' })` (level 3) |
| Distributed transaction across dialects | ❌ not supported — redesign around saga/compensation |

## Scaffolding a service (v0.2.0+)

Rather than writing a sync loop by hand, use the built-in scaffolder to emit a ready-to-run `services/replicator.mjs` into your project :

```bash
# via the standalone bin
npx @mostajs/replicator scaffold --dir . --force

# or programmatically
import { scaffoldReplicatorService } from '@mostajs/replicator'
const result = scaffoldReplicatorService({ projectDir: '.', force: true })
console.log(result.action, result.path)
```

The emitted file :

- Loads `.env` + `.mostajs/config.env`
- Loads `.mostajs/replicator-tree.json` (configured via `mostajs` menu `r`)
- Runs a tick loop every `REPLICATOR_INTERVAL_MS` (default 30s)
- Calls `rm.sync(rule.name)` for every enabled CDC rule
- Logs stats per rule, exits cleanly on SIGTERM

Wire it into your `package.json` :

```json
"scripts": {
  "replicator": "node services/replicator.mjs"
}
```

Then : `npm run replicator` or add it to `concurrently` alongside `next dev`.

`@mostajs/orm-cli@0.5.3+` automates the full setup (scaffold + package.json patch + `concurrently` install) via menu `r → s`.

## License

AGPL-3.0-or-later — (c) 2026 Dr Hamid MADANI <drmdh@msn.com>
