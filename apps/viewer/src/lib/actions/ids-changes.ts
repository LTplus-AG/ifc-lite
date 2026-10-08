/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS correction → reviewed `model.changes` (P15). Uses exactly the typing
 * and unit rules of the direct correction path (#3929): the value type comes
 * from the element's existing property or the facet's dataType, the typed
 * value is in IDS base-SI and is scaled into the model's stored frame, and the
 * IFC dataType is preserved. Each element's current value becomes the
 * expected value, so review shows anything that changed since the audit.
 */

import { validatePropertyDataType } from '@ifc-lite/export';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { CorrectionValueError, inferValueType, parseCorrectionValue, type CorrectionTarget } from '@/hooks/ids/idsCorrection';
import { scaleCorrectionForWrite } from '@/hooks/ids/idsCorrectionScale';
import type { ViewerState } from '@/store';
import { toConversion, type ChangeConversion, type ConversionIssue } from './change-conversion';
import type { ModelChange } from '@ifc-lite/ai/artifacts';
import { currentValue, modelReader, sameValue, UNSUPPORTED_VALUE } from './model-change-values';

export interface IdsCorrectionInput {
  modelId: string;
  target: CorrectionTarget;
  facetDataType?: string;
  expressIds: readonly number[];
  rawValue: string;
  title: string;
}

export function idsCorrectionToModelChanges(state: ViewerState, input: IdsCorrectionInput): ChangeConversion {
  const { modelId, target, title } = input;
  const reader = modelReader(state, modelId);
  if (!reader) return toConversion(title, undefined, [], [{ kind: 'model-unavailable', element: modelId }], 0);
  const accessor = createDataAccessor(reader.dataStore, modelId, reader.view);
  const issues: ConversionIssue[] = [];
  const changes: ModelChange[] = [];
  let unchanged = 0;
  for (const expressId of input.expressIds) {
    const globalId = reader.dataStore.entities.getGlobalId(expressId);
    const element = reader.dataStore.entities.getName(expressId) || globalId || `#${expressId}`;
    if (!globalId) { issues.push({ kind: 'no-global-id', element }); continue; }
    const existing = accessor.getPropertyValue(expressId, target.psetName, target.propName);
    const dataType = existing?.dataType || input.facetDataType;
    let value: string | number | boolean;
    try {
      value = parseCorrectionValue(input.rawValue, inferValueType(existing?.dataType, input.facetDataType));
    } catch (error) {
      if (!(error instanceof CorrectionValueError)) throw error;
      issues.push({ kind: 'invalid-value', element, detail: error.message });
      continue;
    }
    value = scaleCorrectionForWrite(reader.dataStore, expressId, dataType, value);
    let declared: string | undefined;
    try { declared = dataType ? validatePropertyDataType(value, dataType).dataType : undefined; }
    catch (error) {
      issues.push({ kind: 'invalid-value', element, detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const change: ModelChange = { op: 'property.set', target: { globalId, modelId }, pset: target.psetName, name: target.propName,
      expected: null, value, ...(declared ? { dataType: declared } : {}) };
    const current = currentValue(reader, expressId, change);
    if (current === UNSUPPORTED_VALUE) { issues.push({ kind: 'unsupported-value', element }); continue; }
    if (sameValue(current, value)) { unchanged++; continue; }
    changes.push({ ...change, expected: current });
  }
  return toConversion(title, undefined, changes, issues, unchanged);
}
