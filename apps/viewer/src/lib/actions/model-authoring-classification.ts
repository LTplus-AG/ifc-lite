/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { liveEntityConforms } from '@ifc-lite/create';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { ClassificationInput } from '@/lib/authoring/associations';
import { parseText, record } from './model-authoring-fields';

/** Exact reference code spelling is chosen explicitly for the target IFC schema. */
export interface ClassificationAddFields {
  Classification: { Name: string };
  Reference: { Identification?: string; ItemReference?: string; Name?: string };
}

export function parseClassificationAdd(value: Record<string, unknown>, at: string): ClassificationAddFields {
  if (Object.keys(value).some(key => !['op', 'target', 'Classification', 'Reference'].includes(key))) throw new Error(`${at}: classification.add accepts only target, Classification and Reference`);
  const classification = value.Classification, reference = value.Reference;
  if (!record(classification) || Object.keys(classification).some(key => key !== 'Name')) throw new Error(`${at}: Classification needs only Name`);
  if (!record(reference) || Object.keys(reference).some(key => !['Identification', 'ItemReference', 'Name'].includes(key))) {
    throw new Error(`${at}: Reference needs Identification or ItemReference and optional Name`);
  }
  const hasIdentification = reference.Identification !== undefined;
  const hasItemReference = reference.ItemReference !== undefined;
  if (hasIdentification === hasItemReference) throw new Error(`${at}: specify exactly one reference code: Identification or ItemReference`);
  return { Classification: { Name: parseText(classification.Name, `${at} Classification.Name`) }, Reference: {
    ...(hasIdentification ? { Identification: parseText(reference.Identification, `${at} Reference.Identification`) }
      : { ItemReference: parseText(reference.ItemReference, `${at} Reference.ItemReference`) }),
    ...(reference.Name === undefined ? {} : { Name: parseText(reference.Name, `${at} Reference.Name`) }),
  } };
}

/** Map exact EXPRESS fields to the existing native Properties input, without guessing a schema alias. */
export function classificationInput(fields: ClassificationAddFields, schema: string): ClassificationInput {
  if (!['IFC2X3', 'IFC4', 'IFC4X3'].includes(schema)) throw new Error(`Classification authoring is unavailable for ${schema}`);
  const code = schema === 'IFC2X3' ? fields.Reference.ItemReference : fields.Reference.Identification;
  if (code === undefined) throw new Error(`This ${schema} model requires Reference.${schema === 'IFC2X3' ? 'ItemReference' : 'Identification'}`);
  return { system: fields.Classification.Name, identification: code, name: fields.Reference.Name };
}

export function classificationLabel(fields: ClassificationAddFields): string {
  return `${fields.Classification.Name} · ${fields.Reference.Identification ?? fields.Reference.ItemReference}${fields.Reference.Name ? ` · ${fields.Reference.Name}` : ''}`;
}

/** Keep metadata preflight separate from the shared geometry authoring resolver (#7271). */
export function validateClassificationAdd(fields: ClassificationAddFields,
  target: { dataStore: IfcDataStore; view: MutablePropertyView }, expressId: number,
  refuse: (message: string) => never): void {
  try { classificationInput(fields, target.dataStore.schemaVersion); } catch (error) {
    if (error instanceof Error) refuse(error.message);
    throw error;
  }
  if (!liveEntityConforms(target.dataStore, expressId,
    target.dataStore.schemaVersion === 'IFC2X3' ? 'IfcRoot' : 'IfcDefinitionSelect', target.view)) {
    refuse('This element cannot carry a classification in this IFC schema');
  }
}
