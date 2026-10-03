/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { extractProjectUnits, quantitySiScale } from '@ifc-lite/parser';
import { mutationDenial } from '@/store/mutation-permission';
import { QuantityType } from '@ifc-lite/data';
import type { IfcAttributeValue } from '@ifc-lite/mutations';
import type { AuthoringTransaction } from '@/lib/commands/modeling/types';
import { modelEditTarget, recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { emitClippedProfile } from '@/store/slices/mutation-split-slab';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { readSpaceEnvelope } from './space-envelope-read';
import { ceilingAt, envelopeMeasures, type SpaceEnvelope } from './space-envelope';

/** One write path for typed values and snapped gestures. Re-read at commit:
 * selection, permissions, source shape or overlay may have changed since init. */
export function writeSpaceEnvelope(tx: AuthoringTransaction, modelId: string, expressId: number, envelope: SpaceEnvelope): void {
  const denial = mutationDenial(tx.store, modelId);
  if (denial) throw new Error(denial);
  const target = modelEditTarget(tx.store, modelId);
  const read = target && readSpaceEnvelope(target, expressId);
  const measures = read && envelopeMeasures(read.chain.footprint, envelope);
  if (!target || !read || !measures) throw new Error('The space has no supported vertical envelope, or the ceiling crosses its floor.');
  const { chain } = read;
  const previous = envelopeMeasures(chain.footprint, read.envelope)!;
  const k = getModelLengthUnitScale(target.dataStore);
  const qsets = target.view.getQuantitiesForEntity(expressId);
  const units = extractProjectUnits(target.dataStore.source, target.dataStore.entityIndex);
  if (!units.unitForMeasure('IfcLengthMeasure') || !units.unitForMeasure('IfcVolumeMeasure')) throw new Error('The quantity unit scale is unreadable.');
  const lengthScale = quantitySiScale({ name: 'Height', value: 0, type: QuantityType.Length }, units);
  const volumeScale = quantitySiScale({ name: 'GrossVolume', value: 0, type: QuantityType.Volume }, units);
  if (![lengthScale, volumeScale].every(v => Number.isFinite(v) && v > 0)) throw new Error('The quantity unit scale is unreadable.');
  // An explicit quantity unit needs its own conversion, not the project's length factor.
  // Keep that source unchanged until an explicit-unit conversion is available.
  if (qsets.some(q => q.quantities.some(v => ['Height', 'GrossVolume', 'NetVolume'].includes(v.name) && v.unit))) {
    throw new Error('This space uses explicit quantity units that cannot be converted for an envelope edit.');
  }
  recordModellingEdit(tx.api, modelId, (_methods, draft) => {
    const add = (type: string, attrs: IfcAttributeValue[]) => draft.addEntity(type, attrs).expressId;
    const n = (v: number) => v / k;
    const emitted = emitClippedProfile(draft, chain.footprint, chain.placementOrigin, envelope.floor - chain.placementOrigin[2], k);
    let item = add('IfcExtrudedAreaSolid', [`#${emitted.profile}`, `#${emitted.solidPosition}`, `#${emitted.up}`, n(measures.height)]);
    for (const { a, b, c } of envelope.ceiling) {
      const [x, y, z] = chain.placementOrigin;
      const point = add('IfcCartesianPoint', [[0, 0, n(c + a * x + b * y - z)]]);
      const normal = add('IfcDirection', [[-a, -b, 1]]);
      const axis = add('IfcAxis2Placement3D', [`#${point}`, `#${normal}`, null]);
      const plane = add('IfcPlane', [`#${axis}`]);
      // AgreementFlag false selects the normal side: subtract ABOVE the plane.
      const half = add('IfcHalfSpaceSolid', [`#${plane}`, '.F.']);
      item = add('IfcBooleanClippingResult', ['.DIFFERENCE.', `#${item}`, `#${half}`]);
    }
    // Copy representation records as well as the solid: other spaces may share
    // a source representation, and a space edit must never modify their bodies.
    const rep = add('IfcShapeRepresentation', [read.shapeRep[0] as IfcAttributeValue, 'Body', 'Clipping', [`#${item}`]]);
    const reps = read.productShape[2] as IfcAttributeValue[];
    const shape = add('IfcProductDefinitionShape', [read.productShape[0] as IfcAttributeValue, read.productShape[1] as IfcAttributeValue, [`#${rep}`, ...reps.slice(1)]]);
    draft.setPositionalAttribute(expressId, 6, `#${shape}`);
    const view = draft.getMutationView();
    const canonical = qsets.filter(q => q.name === 'Qto_SpaceBaseQuantities' || q.name === 'BaseQuantities');
    const names = canonical.length ? [...new Set(canonical.map(q => q.name))] : ['Qto_SpaceBaseQuantities'];
    // IFC Qto_SpaceBaseQuantities.Height is defined only for constant-height
    // spaces. A ridge maximum is not that quantity (#6686).
    const constant = chain.footprint.every(p => Math.abs(ceilingAt(envelope.ceiling, p) - envelope.floor - measures.height) <= 1e-6);
    for (const qset of names) {
      if (constant) view.setQuantity(expressId, qset, 'Height', measures.height / lengthScale, QuantityType.Length);
      else view.deleteQuantity(expressId, qset, 'Height');
      // Source wall/ceiling and finish dimensions need boundary/construction
      // geometry unavailable to this editor. Remove stale values, never present
      // a geometric envelope measure as a finished construction quantity.
      for (const name of ['GrossWallArea', 'NetWallArea', 'GrossCeilingArea', 'NetCeilingArea', 'FinishCeilingHeight', 'FinishFloorHeight']) {
        view.deleteQuantity(expressId, qset, name);
      }
      for (const prefix of ['Gross', 'Net']) {
        const quantities = canonical.filter(q => q.name === qset).flatMap(q => q.quantities);
        const floors = quantities.filter(q => q.name === `${prefix}FloorArea`);
        // Room creation can retain distinct gross/net outlines. Only the body
        // outline is available here; a different floor measure cannot identify
        // the missing sloped envelope. Invalidate its volume rather than scale
        // by an area ratio or overwrite gross and net with the same value.
        const matchesBody = floors.length > 0 && floors.every(q => {
          const scale = quantitySiScale(q, units);
          return q.type === QuantityType.Area && !q.unit && Number.isFinite(scale) && scale > 0
            && Math.abs(q.value * scale - measures.area) <= Math.max(1e-6, measures.area * 1e-6);
        });
        // A pre-existing net volume can exclude columns/recesses not encoded
        // in the simple body. Preserve that distinction by invalidating it.
        const volumesMatchBody = quantities.filter(q => q.name === `${prefix}Volume`).every(q => q.type === QuantityType.Volume
          && Math.abs(q.value * volumeScale - previous.volume) <= Math.max(1e-6, previous.volume * 1e-6));
        if (matchesBody && volumesMatchBody) view.setQuantity(expressId, qset, `${prefix}Volume`, measures.volume / volumeScale, QuantityType.Volume);
        else view.deleteQuantity(expressId, qset, `${prefix}Volume`);
      }
    }
  }, tx.batchId);
}
