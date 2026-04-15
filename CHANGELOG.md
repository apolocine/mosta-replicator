# Changelog

All notable changes to `@mostajs/replicator` will be documented in this file.

## [0.2.2] — 2026-04-15

### Added — `'*'` wildcard resolved LIVE from master DB

When `rule.collections` contains `'*'`, the emitted `services/replicator.mjs`
now resolves the wildcard **at every tick** by introspecting the master
replica's catalogue :

- SQL dialects : `dialect.executeQuery(dialect.getTableListQuery())`
- MongoDB      : `db.listCollections()`

Then `rm.removeReplicationRule` + `rm.addReplicationRule` with the
resolved list replaces the in-memory rule for the current tick. The tree
on disk keeps `'*'` untouched — the next tick re-resolves, so **new
tables added to the master after the rule was created are replicated
automatically**.

Log sample :

```
[replicator] 2026-04-15T… cdc-fitzone : expanded '*' → 40 table(s)
[replicator] 2026-04-15T… sync cdc-fitzone — ins=0 upd=0 del=0 fail=0
```

Regenerate the service to pick this up :

```bash
npx mostajs-replicator-scaffold --force
```

## [0.2.1] — 2026-04-15

### Fixed — emitted `services/replicator.mjs` now actually connects

The v0.2.0 template called `rm.loadFromFile(TREE)` which parsed the tree
but did **not** open the DB connections — every `rm.sync(rule)` throws
`Pas de master connecte pour le projet source "X"`. Users hit this
immediately with `npm run replicator`.

The template now parses the tree JSON directly and replays
`pm.addProject` + `rm.addReplica` + `rm.addReplicationRule` +
`rm.setReadRouting` — which does open the connections.

Also : when a replica URI contains `:***@` (masked — typical of trees
saved by pre-`orm-cli@0.5.6`), a warning is logged pointing to the
rebuild path (`mostajs` menu r → 1 re-preserves the URI verbatim since
orm-cli 0.5.6).

Regenerate the service to pick the fix up :

```bash
npx mostajs-replicator-scaffold --force
```

## [0.2.0] — 2026-04-15

### Added

- **`scaffoldReplicatorService({ projectDir, servicePath?, force?, dryRun? })`** —
  programmatic API that emits a ready-to-run `services/replicator.mjs`
  into a target project. The emitted service loads `.env` +
  `.mostajs/config.env`, loads the replicator-tree.json, and runs a sync
  loop every `REPLICATOR_INTERVAL_MS` (default 30s) on every enabled rule.
- **`mostajs-replicator-scaffold`** (bin) — standalone CLI wrapping the
  scaffolder. Supports `--dir`, `--path`, `--force`, `--dry-run`.
- `@mostajs/orm-cli@0.5.3+` menu `r → s` uses this scaffolder to provision
  background services without users touching raw Node code.

### Rationale

Previously any project wanting a live replication loop had to hand-write
its own `services/replicator.mjs`. This forced users to mirror the
replicator's internal sync contract — brittle when the lib evolves.
Shipping the scaffolder in the lib itself guarantees version alignment :
`replicator@0.x` always emits a `replicator.mjs` compatible with `0.x`.

## [0.1.1] — 2026-04-13

- SchemaMapper compatibility report, CDC listener prototype.

## [0.1.0] — 2026-04-12

- Initial release : ReplicationManager, CQRS master/slave, cross-dialect
  CDC rules, read routing, failover, SyncEngine, schema-mapper.
