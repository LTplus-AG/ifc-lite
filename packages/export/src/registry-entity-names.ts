/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * STEP type token (`IFCTEXTUREMAP`) -> the generated schema registry's own
 * PascalCase entity name (`IfcTextureMap`), derived once from all three
 * runtime registries `@ifc-lite/parser` carries (IFC2X3/IFC4/IFC4X3), for a
 * caller that already knows which STEP type a source line names and needs
 * to read that entity's OWN declaration back out of the version-correct
 * registry (`getSchemaRegistryForVersion(version).entities[name]`, whose
 * keys are PascalCase, not the upper-case token a STEP line carries).
 *
 * Not the same map `nonrel-ref-list-types.ts` derives: that one is scoped
 * to the types that QUALIFY for its own narrowing rule (an entity gets a
 * registry-name entry there only if it has a qualifying aggregate
 * attribute). This one has no qualifying condition — every concrete AND
 * abstract entity name across the three registries — because a caller here
 * is not asking "does this type qualify for some rule", only "what is this
 * STEP token's registry key". Deriving it independently, rather than
 * reusing `nonrel-ref-list-types.ts`'s narrower map, means a type that
 * later stops qualifying for THAT file's rule (a schema revision, a
 * tightened gate) cannot silently disappear from THIS lookup too.
 */
import { getSchemaRegistryForVersion, type SchemaVersionWithRegistry } from '@ifc-lite/parser';

const REGISTRY_VERSIONS: readonly SchemaVersionWithRegistry[] = ['IFC2X3', 'IFC4', 'IFC4X3'];

function deriveEntityRegistryNames(): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const version of REGISTRY_VERSIONS) {
    const registry = getSchemaRegistryForVersion(version);
    for (const entity of Object.values(registry.entities)) {
      names.set(entity.name.toUpperCase(), entity.name);
    }
  }
  return names;
}

/** STEP type token -> registry PascalCase entity name, across IFC2X3/IFC4/IFC4X3. */
export const ENTITY_REGISTRY_NAMES: ReadonlyMap<string, string> = deriveEntityRegistryNames();
