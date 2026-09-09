/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Select the codegen-generated runtime schema registry by the model's
 * `schemaVersion` (#4202).
 *
 * Before this file, `@ifc-lite/parser` exported exactly one
 * {@link SchemaRegistry} — the IFC4 pin at `./schema-registry.js`, generated
 * from `packages/codegen/schemas/IFC4_ADD2_TC1.exp`. A caller holding an
 * IFC2X3 or IFC4X3 store had no per-version registry to ask: attribute
 * EXPRESS types, optionality, enum/select domains and inheritance chains for
 * those two schemas existed nowhere in this repo (the IFC2X3 table in
 * `@ifc-lite/data` carries attribute NAMES only, vendored from
 * `SchemaInfo.*.g.cs`, not EXPRESS types).
 *
 * `./ifc4x3/schema-registry.ts` and `./ifc2x3/schema-registry.ts` are the
 * same codegen output as the IFC4 mirror at `./schema-registry.ts` — copied
 * byte-for-byte from `packages/codegen/generated/{ifc4x3,ifc2x3}/
 * schema-registry.ts` (`scripts/check-codegen-sync.mjs` regenerates all
 * three from their committed `.exp` sources and fails CI if a copy has
 * drifted). Only `schema-registry.ts` is mirrored per non-IFC4 version, not
 * the full `entities.ts` / `types.ts` / `enums.ts` / `selects.ts` compile-time
 * interface set — three copies of those under one flat `./generated`
 * directory would redeclare the same TypeScript type names (`IfcWall`, …)
 * for classes shared across schemas. The IFC4 mirror keeps its full
 * compile-time surface (`export * from` in `./index.ts`) because it is the
 * package's existing public API; this file adds only the runtime metadata
 * needed to answer "what does entity X look like in schema Y" for the other
 * two.
 *
 * The IFC4 answer is unchanged: `getSchemaRegistryForVersion('IFC4')`
 * returns the exact `SCHEMA_REGISTRY` object already exported from
 * `./schema-registry.js`, so every existing caller of that export keeps its
 * byte-identical answer.
 */

import { SCHEMA_REGISTRY as SCHEMA_REGISTRY_IFC4, type SchemaRegistry } from './schema-registry.js';
import { SCHEMA_REGISTRY as SCHEMA_REGISTRY_IFC4X3 } from './ifc4x3/schema-registry.js';
import { SCHEMA_REGISTRY as SCHEMA_REGISTRY_IFC2X3 } from './ifc2x3/schema-registry.js';

export type { SchemaRegistry };

/** The schema versions a codegen-generated runtime registry exists for. */
export type SchemaVersionWithRegistry = 'IFC2X3' | 'IFC4' | 'IFC4X3';

const REGISTRIES_BY_VERSION: Record<SchemaVersionWithRegistry, SchemaRegistry> = {
  IFC2X3: SCHEMA_REGISTRY_IFC2X3,
  IFC4: SCHEMA_REGISTRY_IFC4,
  IFC4X3: SCHEMA_REGISTRY_IFC4X3,
};

/**
 * Look up the codegen-generated runtime registry for a model's schema
 * version.
 *
 * Fails loud rather than answering an empty registry: a registry whose
 * `entities` map has zero keys means the generator did not run against that
 * schema (an unreachable `.exp` file, a build that skipped codegen, …), not
 * that the schema legitimately declares no entities — no bundled IFC schema
 * does. Silently returning that empty object would look identical to "this
 * class genuinely isn't in the schema" to every caller, which is exactly the
 * failure mode `packages/codegen/schemas/` had for IFC2X3 before this file
 * existed (see module doc). Callers that need "unknown version" to be a
 * normal, handled case should check {@link SchemaVersionWithRegistry}
 * membership themselves before calling.
 */
export function getSchemaRegistryForVersion(version: SchemaVersionWithRegistry): SchemaRegistry {
  const registry = REGISTRIES_BY_VERSION[version];
  if (registry === undefined) {
    throw new Error(
      `getSchemaRegistryForVersion(${JSON.stringify(version)}): no codegen-generated registry exists for ` +
        `this schema version. Supported versions: ${Object.keys(REGISTRIES_BY_VERSION).join(', ')}.`,
    );
  }
  return assertNonEmptyRegistry(registry, version);
}

/**
 * The zero-entities guard, factored out so a test can exercise it against a
 * synthetic empty registry without needing a generator run that actually
 * produces one. Not exported for general use — go through
 * {@link getSchemaRegistryForVersion}.
 */
export function assertNonEmptyRegistry(
  registry: SchemaRegistry,
  version: SchemaVersionWithRegistry,
): SchemaRegistry {
  const entityCount = Object.keys(registry.entities).length;
  if (entityCount === 0) {
    throw new Error(
      `getSchemaRegistryForVersion(${JSON.stringify(version)}): the codegen-generated registry has zero ` +
        'entities. This means the generator did not run (or ran against an unreachable/empty schema file) ' +
        'rather than that the schema has no entities — no bundled IFC schema does. Regenerate with ' +
        '`pnpm --filter @ifc-lite/codegen run generate:' +
        version.toLowerCase() +
        '` and re-copy into packages/parser/src/generated.',
    );
  }
  return registry;
}
