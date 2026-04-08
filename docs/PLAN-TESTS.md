# @mostajs/replicator — Plan de tests
// Author: Dr Hamid MADANI drmdh@msn.com
// Date: 2026-04-07

---

## 1. Tests unitaires (sans SGBD)

### T1 — Instanciation
- [ ] `new ReplicationManager()` sans ProjectManager → OK
- [ ] `new ReplicationManager(pm)` avec ProjectManager → OK
- [ ] Etat initial : `size === 0`, `listProjects() === []`, `listRules() === []`

### T2 — Gardes et validations
- [ ] `addReplica('unknown-project', ...)` avec pm → throw "introuvable"
- [ ] `addReplica('p1', { name: 'm1', role: 'master', ... })` deux fois → throw "existe deja"
- [ ] Ajouter 2 masters au meme projet → throw "deja un master"
- [ ] `removeReplica('unknown', 'x')` → throw "n'a pas de replicas"
- [ ] `removeReplica('p1', 'unknown')` → throw "introuvable"
- [ ] `promoteToMaster('p1', 'x')` sur replica non connectee → throw "n'est pas connectee"
- [ ] `addReplicationRule({name: 'r1', ...})` deux fois → throw "existe deja"
- [ ] `removeReplicationRule('unknown')` → throw "introuvable"
- [ ] `sync('unknown')` → throw "introuvable"
- [ ] `sync('r1')` quand rule.enabled=false → throw "desactivee"

### T3 — Gestion replicas (avec SQLite :memory:)
- [ ] `addReplica('p1', master)` → status 'connected', role 'master'
- [ ] `addReplica('p1', slave)` → status 'connected', role 'slave'
- [ ] `getReplicaStatus('p1')` → 2 replicas, master + slave
- [ ] `listProjects()` → ['p1']
- [ ] `hasReplicas('p1')` → true
- [ ] `size` → 2
- [ ] `removeReplica('p1', 'slave')` → size 1
- [ ] `removeReplica('p1', 'master')` → size 0, projet supprime

### T4 — Failover (promoteToMaster)
- [ ] Setup : master + 2 slaves
- [ ] `promoteToMaster('p1', 'slave-1')` → slave-1.role === 'master', ancien master.role === 'slave'
- [ ] `promoteToMaster('p1', 'slave-1')` (deja master) → noop

### T5 — Read routing
- [ ] `setReadRouting('p1', 'round-robin')` → `getReadRouting('p1')` === 'round-robin'
- [ ] `setReadRouting('p1', 'least-lag')` → OK
- [ ] `setReadRouting('p1', 'random')` → OK
- [ ] `resolveReadService('p1')` avec slaves → retourne un EntityService
- [ ] `resolveReadService('p1')` sans slaves → fallback master
- [ ] `resolveReadService('unknown')` → null

### T6 — Replication rules
- [ ] `addReplicationRule({name, source, target, mode: 'cdc', collections, conflictResolution: 'source-wins'})` → OK
- [ ] `listRules()` → 1 rule, enabled === true
- [ ] `sync('r1')` → retourne SyncStats { recordsSynced: 0, errors: 0 }
- [ ] `getSyncStats('r1')` → memes stats
- [ ] `removeReplicationRule('r1')` → listRules().length === 0

### T7 — Persistence
- [ ] `saveToFile('/tmp/replicator-test.json')` → fichier cree
- [ ] `loadFromFile('/tmp/replicator-test.json')` → routing + rules restaures
- [ ] `enableAutoPersist('/tmp/replicator-auto.json')` + addReplica → fichier mis a jour

### T8 — Lifecycle
- [ ] `disconnectAll()` → tous les replicas status 'disconnected'
- [ ] Double `disconnectAll()` → pas d'erreur

---

## 2. Tests d'integration (multi-dialecte)

### T9 — PostgreSQL master + SQLite slave
- [ ] Master postgres, slave sqlite, memes schemas
- [ ] CRUD sur master → lecture sur slave (apres sync)
- [ ] `resolveReadService` routing vers slave

### T10 — PostgreSQL master + MongoDB slave (cross-dialect)
- [ ] Replication rule pg → mongo
- [ ] `sync('pg-to-mongo')` → donnees presentes dans mongo

---

## 3. Matrice de couverture

| Test | Unitaire | Integration | Script |
|---|---|---|---|
| T1 Instanciation | ✅ | — | test-unit.sh |
| T2 Gardes | ✅ | — | test-unit.sh |
| T3 Gestion replicas | ✅ | — | test-unit.sh |
| T4 Failover | ✅ | — | test-unit.sh |
| T5 Read routing | ✅ | — | test-unit.sh |
| T6 Rules CDC | ✅ | — | test-unit.sh |
| T7 Persistence | ✅ | — | test-unit.sh |
| T8 Lifecycle | ✅ | — | test-unit.sh |
| T9 PG+SQLite | — | ✅ | test-integration-pg-sqlite.sh |
| T10 PG+Mongo | — | ✅ | test-integration-pg-mongo.sh |
