/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The saved Lens v1 shape, used only while importing older JSON (#5896). */
export type PersistedV1LensOperator =
  | 'equals' | 'contains' | 'exists' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

export const MAX_PERSISTED_V1_COMPOUND_DEPTH = 16;

/** Preserve all known fields so conversion can warn on meanings the shared
 * FilterGroup evaluator cannot represent exactly. */
export interface PersistedV1LensCriteria {
  type: 'ifcType' | 'property' | 'material' | 'attribute' | 'quantity' | 'classification' | 'model' | 'group' | 'and' | 'or';
  conditions?: PersistedV1LensCriteria[];
  ifcType?: string;
  propertySet?: string;
  propertyName?: string;
  operator?: PersistedV1LensOperator;
  propertyValue?: string;
  materialName?: string;
  attributeName?: string;
  attributeValue?: string;
  quantitySet?: string;
  quantityName?: string;
  quantityValue?: string;
  classificationSystem?: string;
  classificationCode?: string;
  modelId?: string;
  groupName?: string;
}
