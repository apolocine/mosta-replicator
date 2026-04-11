// @mostajs/replicator — SchemaMapper
// Cross-dialect schema validation, compatibility checks, and data transformation
// Author: Dr Hamid MADANI drmdh@msn.com

import type { EntitySchema } from '@mostajs/orm'

// ══════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════

export type CompatSeverity = 'ok' | 'warning' | 'error'

export interface CompatIssue {
  severity: CompatSeverity
  collection: string
  field?: string
  message: string
}

export interface CompatReport {
  compatible: boolean
  issues: CompatIssue[]
  sourceDialect: string
  targetDialect: string
}

/** String length limits per dialect for 'string' type fields */
const STRING_LIMITS: Record<string, number> = {
  mysql:     255,
  mariadb:   255,
  oracle:    4000,
  db2:       4000,
  sqlite:    Infinity,
  postgres:  Infinity,
  cockroach: Infinity,
  mssql:     Infinity, // NVARCHAR(MAX)
  sybase:    Infinity,
  hana:      5000,
  hsql:      Infinity,
  spanner:   2621440,  // 2.5MB
  mongodb:   Infinity,
}

/** Dialects with native JSON support */
const NATIVE_JSON: Set<string> = new Set(['postgres', 'cockroach', 'mysql', 'mariadb', 'mongodb'])

/** Dialects with native boolean */
const NATIVE_BOOLEAN: Set<string> = new Set(['postgres', 'cockroach', 'db2', 'mongodb'])

/** Dialects with native array support */
const NATIVE_ARRAY: Set<string> = new Set(['postgres', 'cockroach', 'mongodb'])

// ══════════════════════════════════════════════════════════
// SchemaMapper
// ══════════════════════════════════════════════════════════

/**
 * SchemaMapper — validates cross-dialect schema compatibility and
 * provides data transformation helpers for CDC replication.
 *
 * Usage:
 *   const mapper = new SchemaMapper('postgres', 'mysql')
 *   const report = mapper.validate(schemas)
 *   if (!report.compatible) { // handle errors }
 */
export class SchemaMapper {
  private sourceDialect: string
  private targetDialect: string

  constructor(sourceDialect: string, targetDialect: string) {
    this.sourceDialect = sourceDialect.toLowerCase()
    this.targetDialect = targetDialect.toLowerCase()
  }

  // ══════════════════════════════════════════════════════════
  // Validation
  // ══════════════════════════════════════════════════════════

  /**
   * Validate schema compatibility between source and target dialects.
   * Returns a report with issues (warnings and errors).
   */
  validate(schemas: EntitySchema[]): CompatReport {
    const issues: CompatIssue[] = []

    for (const schema of schemas) {
      this.validateFields(schema, issues)
      this.validateRelations(schema, issues)
      this.validateFeatures(schema, issues)
    }

    return {
      compatible: !issues.some(i => i.severity === 'error'),
      issues,
      sourceDialect: this.sourceDialect,
      targetDialect: this.targetDialect,
    }
  }

  /**
   * Validate a single schema's fields for cross-dialect compatibility.
   */
  private validateFields(schema: EntitySchema, issues: CompatIssue[]): void {
    const srcLimit = STRING_LIMITS[this.sourceDialect] ?? Infinity
    const tgtLimit = STRING_LIMITS[this.targetDialect] ?? Infinity

    for (const [name, field] of Object.entries(schema.fields)) {
      // String truncation risk
      if (field.type === 'string' && tgtLimit < srcLimit) {
        issues.push({
          severity: 'warning',
          collection: schema.name,
          field: name,
          message: `String field may be truncated: ${this.sourceDialect} (limit: ${srcLimit === Infinity ? 'unlimited' : srcLimit}) → ${this.targetDialect} (limit: ${tgtLimit})`,
        })
      }

      // JSON → non-native JSON dialect
      if (field.type === 'json' && NATIVE_JSON.has(this.sourceDialect) && !NATIVE_JSON.has(this.targetDialect)) {
        issues.push({
          severity: 'warning',
          collection: schema.name,
          field: name,
          message: `JSON field stored as text on ${this.targetDialect} — native JSON queries unavailable`,
        })
      }

      // Array → non-native array dialect
      if (field.type === 'array' && NATIVE_ARRAY.has(this.sourceDialect) && !NATIVE_ARRAY.has(this.targetDialect)) {
        issues.push({
          severity: 'warning',
          collection: schema.name,
          field: name,
          message: `Array field stored as JSON text on ${this.targetDialect} — no native array operations`,
        })
      }
    }
  }

  /**
   * Validate relations for cross-dialect compatibility.
   */
  private validateRelations(schema: EntitySchema, issues: CompatIssue[]): void {
    const srcIsMongo = this.sourceDialect === 'mongodb'
    const tgtIsMongo = this.targetDialect === 'mongodb'

    for (const [name, rel] of Object.entries(schema.relations)) {
      if (rel.type === 'many-to-many') {
        if (srcIsMongo !== tgtIsMongo) {
          issues.push({
            severity: 'warning',
            collection: schema.name,
            field: name,
            message: `M2M relation "${name}": ${srcIsMongo ? 'MongoDB embedded arrays' : 'SQL junction table'} → ${tgtIsMongo ? 'MongoDB embedded arrays' : 'SQL junction table'} — sync requires relation-aware mode`,
          })
        }

        if (!srcIsMongo && !tgtIsMongo && rel.through) {
          // SQL → SQL M2M with junction table — need to sync junction table too
          issues.push({
            severity: 'warning',
            collection: schema.name,
            field: name,
            message: `M2M junction table "${rel.through}" must be synced separately or use relation-aware sync`,
          })
        }
      }
    }
  }

  /**
   * Validate dialect feature compatibility.
   */
  private validateFeatures(schema: EntitySchema, issues: CompatIssue[]): void {
    // Soft-delete: all dialects support it (it's just a date field)
    // Discriminator: all dialects support it (it's just a string field)
    // Timestamps: all dialects support createdAt/updatedAt

    // Only warn about boolean representation if crossing native/non-native boundary
    const hasBoolFields = Object.values(schema.fields).some(f => f.type === 'boolean')
    if (hasBoolFields) {
      const srcNative = NATIVE_BOOLEAN.has(this.sourceDialect)
      const tgtNative = NATIVE_BOOLEAN.has(this.targetDialect)
      if (srcNative !== tgtNative) {
        issues.push({
          severity: 'ok',
          collection: schema.name,
          message: `Boolean fields: ${this.sourceDialect} (${srcNative ? 'native' : '1/0'}) → ${this.targetDialect} (${tgtNative ? 'native' : '1/0'}) — handled by ORM serialization`,
        })
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // Data transformation helpers
  // ══════════════════════════════════════════════════════════

  /**
   * Check if a string value would be truncated on the target dialect.
   * Returns the max length or Infinity if unlimited.
   */
  getTargetStringLimit(): number {
    return STRING_LIMITS[this.targetDialect] ?? Infinity
  }

  /**
   * Check if target dialect has native JSON support.
   */
  targetHasNativeJson(): boolean {
    return NATIVE_JSON.has(this.targetDialect)
  }

  /**
   * Check if the pair involves Mongo ↔ SQL (requires M2M relation mapping).
   */
  isCrossParadigm(): boolean {
    const srcMongo = this.sourceDialect === 'mongodb'
    const tgtMongo = this.targetDialect === 'mongodb'
    return srcMongo !== tgtMongo
  }

  /**
   * Get a list of collections that have M2M relations requiring special handling.
   */
  getM2MCollections(schemas: EntitySchema[]): string[] {
    return schemas
      .filter(s => Object.values(s.relations).some(r => r.type === 'many-to-many'))
      .map(s => s.name)
  }

  /**
   * Get the M2M relation names for a collection.
   */
  getM2MRelations(schema: EntitySchema): string[] {
    return Object.entries(schema.relations)
      .filter(([, r]) => r.type === 'many-to-many')
      .map(([name]) => name)
  }
}
