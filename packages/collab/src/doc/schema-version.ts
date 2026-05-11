/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-version helpers (open problem #2 — v1.0 prep).
 *
 * The current IFCX schema version of a Y.Doc lives in the top-level
 * `meta` Y.Map under `schemaVersion`. This module gives that field a
 * typed accessor + a tiny migration registry so v1.0 can ship the
 * server-mediated migration flow without a bigger refactor.
 *
 * The actual structural migrations (e.g. attribute renames between
 * IFC4 → IFC4X3) are out of scope for v0.x — this is the wiring.
 */

import * as Y from 'yjs';
import { metaMap } from './schema.js';

/**
 * Schema versions we recognize.
 *
 * `unknown` is what older docs (or hand-built ones) report when no
 * version was ever set. We treat it as IFC5 for collab purposes since
 * that's what IFCX targets.
 */
export type SchemaVersion = 'ifc4' | 'ifc4x3' | 'ifc5' | 'unknown';

const KEY = 'schemaVersion';

export function getSchemaVersion(doc: Y.Doc): SchemaVersion {
  const v = metaMap(doc).get(KEY);
  if (v === 'ifc4' || v === 'ifc4x3' || v === 'ifc5') return v;
  return 'unknown';
}

export function setSchemaVersion(doc: Y.Doc, version: SchemaVersion): void {
  metaMap(doc).set(KEY, version);
}

/**
 * Migration registry: each entry transforms `(doc) => doc'` in-place
 * inside a single transaction. Migrations are looked up by
 * `(from, to)` pair.
 *
 * v0.x ships an empty registry intentionally — registering one is the
 * v1.0 task. The shape is stable so consumers can author migrations
 * without further API churn.
 */
export interface SchemaMigration {
  from: SchemaVersion;
  to: SchemaVersion;
  apply: (doc: Y.Doc) => void;
}

const REGISTRY: SchemaMigration[] = [];

export function registerSchemaMigration(migration: SchemaMigration): void {
  REGISTRY.push(migration);
}

export function listSchemaMigrations(): readonly SchemaMigration[] {
  return REGISTRY;
}

/**
 * Run a single migration in a transaction tagged with our migration
 * origin. Returns true when applied, false if the doc isn't at `from`
 * or no migration is registered.
 */
export function migrateSchema(doc: Y.Doc, from: SchemaVersion, to: SchemaVersion): boolean {
  if (getSchemaVersion(doc) !== from) return false;
  const migration = REGISTRY.find((m) => m.from === from && m.to === to);
  if (!migration) return false;
  doc.transact(() => {
    migration.apply(doc);
    setSchemaVersion(doc, to);
  }, MIGRATION_ORIGIN);
  return true;
}

/** Origin tag used by migration transactions so observers can filter them. */
export const MIGRATION_ORIGIN = Symbol.for('@ifc-lite/collab/schema-migration');
