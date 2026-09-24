/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolve a `SpatialAnchor` from a parsed `IfcDataStore` and optional live
 * mutation view.
 *
 * Walks the entity index for the IfcOwnerHistory, the 'Body'
 * IfcGeometricRepresentationSubContext (falling back to the model's
 * 3D IfcGeometricRepresentationContext), and the target storey's
 * IfcLocalPlacement.
 */

import { EntityExtractor, resolveEffectiveEntityRecord, type EffectiveEntityRecord, type IfcDataStore } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import type { SpatialAnchor, SpatialAnchorSchema } from './anchor.js';
import { safeLengthUnitScale } from './length-unit-scale.js';

export function resolveSpatialAnchor(
  store: IfcDataStore,
  storeyExpressId: number,
  view?: MutablePropertyView | null,
): SpatialAnchor {
  const reader = new AnchorEntityReader(store, view);
  // OwnerHistory is OPTIONAL from IFC4 onward — minimal files (including
  // ifc-lite's own exports) legitimately omit it. Builders emit `$` then.
  const ownerHistoryId = reader.firstId('IFCOWNERHISTORY');

  const rootContextId = reader.rootContextId();
  const bodyContextId = reader.contextId('body', rootContextId);
  if (bodyContextId === null) {
    throw new Error('resolveSpatialAnchor: no IfcGeometricRepresentationContext (or Body subcontext) found in store');
  }

  const axisContextId = reader.contextId('axis', rootContextId);
  if (axisContextId === null) {
    throw new Error('resolveSpatialAnchor: no IfcGeometricRepresentationContext (or Axis subcontext) found in store');
  }


  const storeyPlacementId = reader.storeyPlacementId(storeyExpressId);
  if (storeyPlacementId === null) {
    throw new Error(`resolveSpatialAnchor: storey #${storeyExpressId} has no resolvable IfcLocalPlacement`);
  }

  const schema = (store.schemaVersion ?? 'IFC4') as SpatialAnchorSchema;

  // Unlike IFC4+, IfcRoot.OwnerHistory is MANDATORY in IFC2X3. Every builder
  // (addWallToStore, addBeamToStore, ...) blindly emits `$` when
  // ownerHistoryId is null, which is fine for IFC4+ but would silently write
  // a malformed IFC2X3 file (mandatory attribute emitted as `$`) for a store
  // that itself is missing IfcOwnerHistory. Refuse here rather than let that
  // through quietly.
  if (schema === 'IFC2X3' && ownerHistoryId === null) {
    throw new Error(
      'resolveSpatialAnchor: IFC2X3 requires IfcOwnerHistory (IfcRoot.OwnerHistory is mandatory in ' +
        'IFC2X3), but the store has none — cannot author new IFC2X3 elements without one',
    );
  }

  // Builder params are metres; the file may not be (e.g. millimetre Revit
  // exports). Resolve the length-unit scale here so builders can emit
  // coordinates in the file's native unit — mirrors the read-side
  // conversion in extract-walls.ts.
  // Keep the metre fallback on a failed lookup, but don't hide it — a wrong
  // scale emits silently mis-sized geometry. `safeLengthUnitScale` warns.
  const lengthUnitScale = store.source.byteLength > 0
    ? safeLengthUnitScale(store.source, store.entityIndex, 'resolveSpatialAnchor') ?? 1.0
    : 1.0;

  return { ownerHistoryId, bodyContextId, axisContextId, rootContextId, storeyId: storeyExpressId, storeyPlacementId, schema, lengthUnitScale };
}

/** Read source and overlay entities through the same effective ID boundary. */
class AnchorEntityReader {
  private readonly extractor: EntityExtractor | null;

  constructor(
    private readonly store: IfcDataStore,
    private readonly view: MutablePropertyView | null | undefined,
  ) {
    this.extractor = store.source.byteLength > 0 ? new EntityExtractor(store.source) : null;
  }

  private *ids(type: string): IterableIterator<number> {
    for (const { expressId } of iterateEffectiveEntityIds(this.store, this.view, [type])) {
      yield expressId;
    }
  }

  firstId(type: string): number | null {
    return this.ids(type).next().value ?? null;
  }

  /** Prefer the named subcontext, then the root 3D context. */
  contextId(identifier: 'body' | 'axis', rootContextId: number | null): number | null {
    for (const id of this.ids('IFCGEOMETRICREPRESENTATIONSUBCONTEXT')) {
      const value = this.entity(id)?.attributes[1];
      if (typeof value === 'string' && value.toLowerCase() === identifier) return id;
    }

    return rootContextId;
  }

  /** The model's root 3D context, never a subcontext. */
  rootContextId(): number | null {
    let fallback: number | null = null;
    for (const id of this.ids('IFCGEOMETRICREPRESENTATIONCONTEXT')) {
      const entity = this.entity(id);
      if (!entity) continue;
      fallback ??= id;
      if (entity.attributes[2] === 3) return id;
    }
    return fallback;
  }

  /** The effective storey's live IfcLocalPlacement, including overlay refs. */
  storeyPlacementId(storeyId: number): number | null {
    const storey = this.entity(storeyId);
    if (storey?.type.toUpperCase() !== 'IFCBUILDINGSTOREY') return null;
    const index = storey.names.indexOf('ObjectPlacement');
    const raw = storey.attributes[index >= 0 ? index : 5];
    const placementId = typeof raw === 'number' && Number.isInteger(raw) && raw > 0
      ? raw
      : typeof raw === 'string' && /^#[1-9][0-9]*$/.test(raw)
        ? Number(raw.slice(1))
        : null;
    if (placementId === null) return null;
    return this.entity(placementId)?.type.toUpperCase() === 'IFCLOCALPLACEMENT'
      ? placementId
      : null;
  }

  private entity(id: number): EffectiveEntityRecord | null {
    if (this.view?.isDeleted(id)) return null;
    const created = this.view?.getNewEntity(id);
    // @raw-entity-enumeration-ok point lookup after effective enumeration; source bytes are needed only for this candidate's attributes
    const ref = created ? undefined : this.store.entityIndex.byId.get(id);
    const source = ref && this.extractor ? this.extractor.extractEntity(ref) : null;
    const entity = created ?? source;
    if (!entity) return null;
    return resolveEffectiveEntityRecord(entity, {
      retype: this.view?.getEntityTypeMutation(id)?.newType,
      named: this.view?.getAttributeMutationsForEntity(id).map(({ name, value }) => [name, value] as const) ?? [],
      positional: this.view?.getPositionalMutationsForEntity(id) ?? [],
    }, this.store.schemaVersion);
  }
}
