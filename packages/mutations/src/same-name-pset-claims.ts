/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `getForEntity`'s helper for entities that carry two (or more) base
 * property sets sharing a name (a type pset and an occurrence pset, say).
 * A mutation key (`${entityId}:${psetName}:${propName}`) has no identity
 * past the pset NAME, so it can't tell apart which instance a SET/DELETE on
 * an existing property, or a brand-new property, was meant for. Both must
 * still land on exactly ONE instance: the FIRST one (in base-pset order)
 * whose own base properties already carry that name -- matching the "first
 * match across the sequence wins" read semantics
 * `findPropertyInSets`/`PropertyTable.getProperty` already use for
 * same-named reads (#3468). A property that exists on NO instance yet (a
 * genuinely new property) is claimed by the first instance of that pset
 * name, same as a brand-new pset would be.
 */

import type { Property, PropertySet } from '@ifc-lite/data';
import { PropertyValueType } from '@ifc-lite/data';
import type { PropertyMutation } from './types.js';
import { propertyKey } from './types.js';

export interface PsetClaims {
  /** `${psetName}:${propName}` -> the base pset instance that owns edits to it. */
  readonly claimingInstanceForProp: Map<string, PropertySet>;
  /** `psetName` -> the first base pset instance carrying that name. */
  readonly firstInstanceOfPsetName: Map<string, PropertySet>;
}

export function computePsetClaims(basePsets: readonly PropertySet[]): PsetClaims {
  const claimingInstanceForProp = new Map<string, PropertySet>();
  const firstInstanceOfPsetName = new Map<string, PropertySet>();
  for (const pset of basePsets) {
    if (!firstInstanceOfPsetName.has(pset.name)) {
      firstInstanceOfPsetName.set(pset.name, pset);
    }
    for (const prop of pset.properties) {
      const claimKey = `${pset.name}:${prop.name}`;
      if (!claimingInstanceForProp.has(claimKey)) {
        claimingInstanceForProp.set(claimKey, pset);
      }
    }
  }
  return { claimingInstanceForProp, firstInstanceOfPsetName };
}

/**
 * The mutated property list for ONE base pset instance: its own properties
 * with SET/DELETE applied only where this instance is the claiming one for
 * that name, plus any genuinely-new property this instance claims as the
 * first instance of its pset name.
 */
export function mutatedPropertiesForInstance(
  entityId: number,
  pset: PropertySet,
  claims: PsetClaims,
  propertyMutations: ReadonlyMap<string, PropertyMutation>,
  entityPropKeys: ReadonlySet<string> | undefined,
): Property[] {
  const { claimingInstanceForProp, firstInstanceOfPsetName } = claims;

  const mutatedProperties: Property[] = [];
  for (const prop of pset.properties) {
    const isClaimingInstance = claimingInstanceForProp.get(`${pset.name}:${prop.name}`) === pset;
    if (!isClaimingInstance) {
      mutatedProperties.push(prop);
      continue;
    }

    const key = propertyKey(entityId, pset.name, prop.name);
    const mutation = propertyMutations.get(key);
    if (mutation) {
      if (mutation.operation === 'DELETE') continue;
      mutatedProperties.push({
        name: prop.name,
        type: mutation.valueType ?? prop.type,
        value: mutation.value ?? null,
        unit: mutation.unit ?? prop.unit,
        dataType: prop.dataType,
      });
    } else {
      mutatedProperties.push(prop);
    }
  }

  // New properties (never present on any same-named base instance) land on
  // the first instance of this pset name only, and only when no OTHER
  // same-named instance already owns that name in its own base properties
  // (that property isn't new at all, just claimed by the sibling above).
  if (firstInstanceOfPsetName.get(pset.name) === pset && entityPropKeys) {
    const psetPrefix = `${entityId}:${pset.name}:`;
    for (const key of entityPropKeys) {
      if (!key.startsWith(psetPrefix)) continue;
      const mutation = propertyMutations.get(key);
      if (!mutation || mutation.operation !== 'SET') continue;
      const propName = key.slice(psetPrefix.length);
      if (claimingInstanceForProp.has(`${pset.name}:${propName}`)) continue; // owned by a sibling instance's own property
      if (!mutatedProperties.some(p => p.name === propName)) {
        mutatedProperties.push({
          name: propName,
          type: mutation.valueType ?? PropertyValueType.String,
          value: mutation.value ?? null,
          unit: mutation.unit,
        });
      }
    }
  }

  return mutatedProperties;
}
