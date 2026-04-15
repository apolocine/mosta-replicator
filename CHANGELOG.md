# Changelog

All notable changes to `@mostajs/replicator` will be documented in this file.

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
