/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { effectiveMetadataRecord, extractLengthUnitScale, readCurrentProjectUnits, type IfcDataStore } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds, type StoreEditor, type MutablePropertyView } from '@ifc-lite/mutations';

/** Annotation placements are absolute: an unplaced storey is still a valid container. */
export function drawingAnnotationAnchor(store: IfcDataStore, editor: StoreEditor, requestedStorey: number) {
  const view = editor.getMutationView();
  const first = (type: string) => iterateEffectiveEntityIds(store, view, [type]).next().value?.expressId ?? null;
  const storeyId = effectiveMetadataRecord(store, requestedStorey, view)?.type.toUpperCase() === 'IFCBUILDINGSTOREY'
    ? requestedStorey : first('IFCBUILDINGSTOREY');
  let rootContextId: number | null = null;
  for (const { expressId } of iterateEffectiveEntityIds(store, view, ['IFCGEOMETRICREPRESENTATIONCONTEXT'])) {
    if (effectiveMetadataRecord(store, expressId, view)?.attributes[2] === 3) { rootContextId = expressId; break; }
  }
  if (rootContextId === null) {
    const point = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
    const axes = editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
    rootContextId = editor.addEntity('IfcGeometricRepresentationContext', [null, 'Model', 3, 1e-5, `#${axes}`, null]).expressId;
    const project = first('IFCPROJECT');
    if (project) {
      const existing = effectiveMetadataRecord(store, project, view)?.attributes[7];
      const contexts = Array.isArray(existing) ? existing.map(id => typeof id === 'number' ? `#${id}` : id) : [];
      editor.setPositionalAttribute(project, 7, [...contexts, `#${rootContextId}`]);
    }
  }
  return { rootContextId, storeyId, lengthUnitScale: drawingAnnotationLengthUnitScale(store, view), ownerHistoryId: first('IFCOWNERHISTORY'), schema: store.schemaVersion };
}

/** Author coordinates in the unit assignment the export view will actually write. */
export function drawingAnnotationLengthUnitScale(store: IfcDataStore, view?: MutablePropertyView): number {
  let lengthUnitScale = 1;
  try {
    const current = view ? readCurrentProjectUnits(store, view) : null;
    if (current?.status === 'unavailable') console.warn('Cannot read current drawing annotation units; using source units', current.reason);
    const scale = current?.value?.resolvedForUnitType('LENGTHUNIT')?.siScale ?? extractLengthUnitScale(store.source, store.entityIndex);
    if (Number.isFinite(scale) && scale > 0) lengthUnitScale = scale;
    else console.warn('Drawing annotation length unit scale is invalid', scale);
  } catch (error) { console.warn('Cannot read drawing annotation length units', error); }
  return lengthUnitScale;
}
