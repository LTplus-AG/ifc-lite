/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Handles the entity types `schema-converter.ts`'s hand-listed
 * {@link shouldSkipEntity} does not cover: an entity whose type is entirely
 * absent from the target schema's generated attribute table (not merely a
 * renamed or attribute-count-adjusted counterpart — see
 * `convertStepLine`'s `srcAttrs`/`tgtAttrs` lookup), where the type is not
 * one of `shouldSkipEntity`'s hand-listed alignment entities either.
 *
 * Split out of `schema-converter.ts` to stay under its line budget
 * (`scripts/module-size-allowlist.txt`).
 */

import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import { deterministicGlobalId, getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import type { IfcSchemaVersion } from './schema-converter.js';

/**
 * Whether `type` is an IfcRoot subtype (has a GlobalId as its first
 * attribute), mirroring `merged-exporter.ts`'s `isRootedType`. Not imported
 * from there: `merged-exporter.ts` imports `schema-converter.ts`, and this
 * module is a dependency of `schema-converter.ts`, so importing back from
 * `merged-exporter.ts` would cycle.
 */
function isRootedEntityType(type: string): boolean {
  return getInheritanceChainAcrossSchemas(type).includes('IfcRoot');
}

/**
 * Resolve an entity whose type has NO representation at all in `toSchema`
 * (distinct from a renamed or attribute-count-adjusted one).
 *
 * A rooted (IfcRoot) entity can safely become an IFCPROXY placeholder — the
 * same substitution `schema-converter.ts`'s `shouldSkipEntity` already
 * performs for its hand-listed alignment types, extended here to every other
 * unmapped rooted type instead of silently copying the source line's type and
 * IFC4-shaped attributes under the target schema's header (e.g. an
 * `IFCTRIANGULATEDFACESET` surviving unchanged into a file whose header
 * declares IFC2X3, which IFC2X3 never defined).
 *
 * A non-rooted entity (a representation item or resource type referenced
 * POSITIONALLY — e.g. from an `IfcShapeRepresentation.Items` list, or an
 * `IfcGeometricRepresentationContext`'s coordinate-operation attribute)
 * cannot take the same fallback: IFCPROXY is an IfcProduct, not an
 * IfcRepresentationItem or resource type, so substituting one there swaps one
 * illegal file for a differently-illegal one, and dropping the line would
 * leave the referencing entity's `#N` dangling. Throws instead of guessing.
 */
export function resolveUnrepresentedEntity(
  prefix: string,
  entityType: string,
  attrsRaw: string,
  toSchema: IfcSchemaVersion,
  random?: RandomSource,
): string {
  if (isRootedEntityType(entityType)) {
    const guid = random
      ? generateIfcGuid(random)
      : deterministicGlobalId(`ifcproxy:${prefix}${entityType}(${attrsRaw})`);
    return `${prefix}IFCPROXY('${guid}',$,'${entityType}',$,$,$,$,.NOTDEFINED.,$);`;
  }
  throw new Error(
    `Cannot convert ${prefix}${entityType}(${attrsRaw}) to ${toSchema}: ${entityType} has no ` +
    `representation in ${toSchema} and is not an IfcRoot subtype, so it can be neither dropped ` +
    `(the referencing entity would dangle) nor replaced with IFCPROXY (an IfcProduct, not a valid ` +
    `substitute for a representation item or resource type). Remove or pre-convert this entity ` +
    `before targeting ${toSchema}.`,
  );
}
