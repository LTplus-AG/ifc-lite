/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether `bim.georef` can trust what it reads from the model.
 *
 * `get()` and the planners read georeferencing from the source records plus the
 * few session edits the readers interpret (deletions, numeric/text attribute
 * edits of the conversion and CRS, IFC2X3 convention-set properties). Any other
 * generic mutation of an entity the reading depends on reaches the STEP export
 * without reaching the read, which would let a later write act on a stale value.
 *
 * One rule decides it: enumerate everything the mutation view holds
 * (`getEffectiveChanges`, every kind) and keep a part of the state trusted only
 * for the changes below that the readers interpret. Every other change of an
 * entity the state is read from marks that part untrusted, so a kind of
 * mutation nobody listed lands on the untrusted side. An untrusted part is
 * reported in `get().untrusted`, never carried into a write.
 *
 * References into the read entities from outside (another record pointing at
 * the CRS) change nothing the readers follow, since they only walk forward
 * from the conversion and CRS; the unit closure below covers what they reach.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { EntityExtractor } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { interpretsCrsEdit, interpretsMcEdit } from './attribute-overlay.js';
import { exporterKey, MC_FIELDS } from './plan.js';
import { GeoreferencingError } from './types.js';

export type GeorefPart = 'MapConversion' | 'ProjectedCRS' | 'MapUnit' | 'RigidOperation' | 'site' | 'ePSet';

export interface GeorefTrust {
  /** Why each part is untrusted. */
  reasons: Partial<Record<GeorefPart, string[]>>;
  /** Georeferencing records created through the generic API: the reads never see them, a write can neither replace nor remove them. */
  foreign: string[];
}

const CLASS_PART: Readonly<Record<string, GeorefPart>> = Object.freeze({
  IFCMAPCONVERSION: 'MapConversion', IFCMAPCONVERSIONSCALED: 'MapConversion', IFCRIGIDOPERATION: 'RigidOperation',
  IFCPROJECTEDCRS: 'ProjectedCRS', IFCGEOGRAPHICCRS: 'ProjectedCRS', IFCWELLKNOWNTEXT: 'ProjectedCRS', IFCSITE: 'site',
});
/** Attribute positions that hold references, for the unit records a map unit can chain through. */
const UNIT_REFS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  IFCCONVERSIONBASEDUNIT: [0, 3], IFCCONVERSIONBASEDUNITWITHOFFSET: [0, 3], IFCMEASUREWITHUNIT: [1], IFCSIUNIT: [], IFCDIMENSIONALEXPONENTS: [],
});
/** The "nothing changed" assessment, shared and frozen: an assessment is a value, and a caller that needs to add to one builds its own. */
const NO_TRUST: GeorefTrust = Object.freeze({ reasons: Object.freeze({}), foreign: Object.freeze([]) as unknown as string[] });

/** The entities the georeferencing state is read from, by part, with their STEP class. */
function readEntities(store: IfcDataStore): Map<number, { part: GeorefPart; type: string }> {
  const out = new Map<number, { part: GeorefPart; type: string }>();
  if (!store.entityIndex) return out;
  const extractor = store.source?.length ? new EntityExtractor(store.source) : null;
  const attributes = (id: number): unknown[] => {
    // @raw-entity-enumeration-ok point read of one source record already selected as a georeferencing read target
    const ref = store.entityIndex.byId.get(id);
    return (ref && extractor?.extractEntity(ref)?.attributes) || [];
  };
  // @raw-entity-enumeration-ok membership test of one referenced source id; deletions of the unit records are read from the mutation view
  const exists = (id: number): boolean => store.entityIndex.byId.has(id);
  // @raw-entity-enumeration-ok point read of the class of one source record already selected as a georeferencing read target
  const typeOf = (id: number): string => String(store.entityIndex.byId.get(id)?.type ?? '').toUpperCase();
  for (const [type, part] of Object.entries(CLASS_PART)) {
    // @raw-entity-enumeration-ok source ids of the georeferencing classes; the session's deletions are read from the mutation view below
    for (const id of store.entityIndex.byType.get(type) ?? []) out.set(id, { part, type });
  }
  // The unit a CRS names, and every record that unit is defined through.
  const queue: number[] = [];
  for (const [id, e] of [...out]) {
    const unit = e.type === 'IFCPROJECTEDCRS' ? attributes(id)[6] : undefined;
    if (typeof unit === 'number') queue.push(unit);
  }
  while (queue.length > 0) {
    const id = queue.pop() as number;
    if (out.has(id)) continue;
    const type = typeOf(id);
    out.set(id, { part: 'MapUnit', type });
    const attrs = attributes(id);
    const known = UNIT_REFS[type];
    for (const v of known ? known.map((at) => attrs[at]) : attrs.flat()) if (typeof v === 'number' && exists(v)) queue.push(v);
  }
  return out;
}

/**
 * Assess every change the session's mutation view holds against what the state is read from.
 * `written` is the session's own georeferencing write: a field it sets wins over a generic edit at export.
 */
export function assessTrust(store: IfcDataStore, view: MutablePropertyView, written: { mapConversion?: object; projectedCRS?: object } | null): GeorefTrust {
  if (!view.hasPendingChanges()) return NO_TRUST;
  const changes = view.getEffectiveChanges();
  if (changes.length === 0) return NO_TRUST;
  const reads = readEntities(store);
  const trust: GeorefTrust = { reasons: {}, foreign: [] };
  const flag = (part: GeorefPart, why: string) => { (trust.reasons[part] ??= []).push(why); };
  const covered = (part: GeorefPart, name: string) =>
    exporterKey(name) in ((part === 'MapConversion' ? written?.mapConversion : written?.projectedCRS) ?? {});
  for (const c of changes) {
    // A retype is judged by the class the entity becomes (a created entity's own class says nothing): into a
    // georeferencing class it is a record nobody read, however it started.
    if (c.kind === 'type') {
      const into = CLASS_PART[String(c.newValue).toUpperCase()];
      if (into) {
        flag(into, `#${c.entityId} was retyped to ${c.newValue} outside bim.georef`);
        if (into !== 'site') trust.foreign.push(`${c.newValue} #${c.entityId}`);
        continue;
      }
    }
    if (c.kind === 'entity-added') {
      const part = CLASS_PART[String(c.newValue).toUpperCase()];
      if (!part) continue;
      flag(part, `${c.newValue} #${c.entityId} was created outside bim.georef`);
      if (part !== 'site') trust.foreign.push(`${c.newValue} #${c.entityId}`);
      continue;
    }
    const read = reads.get(c.entityId);
    if (!read) continue;
    const { part, type } = read;
    const what = `${type} #${c.entityId}`;
    switch (c.kind) {
      // The readers skip a deleted conversion, CRS, rigid operation, well-known text and site; a deleted unit record is not followed.
      case 'entity-deleted': if (part === 'MapUnit') flag(part, `${what} was deleted outside bim.georef`); break;
      case 'attribute': {
        const name = c.name ?? '';
        const interpreted = !name.startsWith('@') && (
          (part === 'MapConversion' && (MC_FIELDS as readonly string[]).includes(name) && (covered(part, name) || interpretsMcEdit(name, c.newValue ?? '', type === 'IFCMAPCONVERSIONSCALED')))
          || (type === 'IFCPROJECTEDCRS' && (interpretsCrsEdit(name, c.newValue ?? '') || (name === 'MapUnit' && covered(part, name)))));
        if (!interpreted) flag(part, `${name.startsWith('@') ? `attribute ${name.slice(1)} (by position)` : `attribute ${name}`} of ${what} was edited outside bim.georef`);
        break;
      }
      // Properties and quantities are not what these records are read from, except the IFC2X3 convention sets, which are read back live.
      case 'property': case 'pset-added': case 'pset-deleted': case 'quantity': case 'qset-added': case 'qset-deleted': break;
      default: flag(part, `${what} was changed outside bim.georef (${c.kind})`);
    }
  }
  return trust;
}

/** Whether a write may proceed on this trust, or the typed refusal naming the cause. */
export function assertWritable(action: 'set' | 'update' | 'remove', trust: GeorefTrust): void {
  if (trust.foreign.length > 0) {
    throw new GeoreferencingError(
      'UNSUPPORTED_RECORD',
      `${trust.foreign.join(', ')} ${trust.foreign.length === 1 ? 'was' : 'were'} created through the generic API. bim.georef does not read ${trust.foreign.length === 1 ? 'it' : 'them'} and can neither replace nor remove ${trust.foreign.length === 1 ? 'it' : 'them'}, so the file would carry ${trust.foreign.length === 1 ? 'it' : 'them'} next to this write. Delete ${trust.foreign.length === 1 ? 'it' : 'them'} with the store API first.`,
    );
  }
  if (action !== 'update') return;
  const stale = (['MapConversion', 'ProjectedCRS', 'MapUnit', 'RigidOperation', 'ePSet'] as const).flatMap((p) => trust.reasons[p] ?? []);
  if (stale.length > 0) {
    throw new GeoreferencingError(
      'UNSUPPORTED_RECORD',
      `update keeps the values it is not given, but ${stale.join('; ')}, so ifc-lite does not know their current values. Pass every value with set and replace: true.`,
      ['replace'],
    );
  }
}
