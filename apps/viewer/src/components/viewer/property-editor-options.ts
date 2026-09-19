/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationKey } from '@/i18n';
import { PropertyValueType } from '@ifc-lite/data';

export const INLINE_VALUE_TYPES = [
  { type: PropertyValueType.String, labelKey: 'propertyEditor.valueType.string' },
  { type: PropertyValueType.Label, labelKey: 'propertyEditor.valueType.label' },
  { type: PropertyValueType.Identifier, labelKey: 'propertyEditor.valueType.identifierShort' },
  { type: PropertyValueType.Real, labelKey: 'propertyEditor.valueType.real' },
  { type: PropertyValueType.Integer, labelKey: 'propertyEditor.valueType.integerShort' },
  { type: PropertyValueType.Boolean, labelKey: 'propertyEditor.valueType.booleanShort' },
] as const satisfies ReadonlyArray<{ type: PropertyValueType; labelKey: TranslationKey }>;

export const MATERIAL_CATEGORIES = [
  { value: 'Concrete', labelKey: 'propertyEditor.material.category.concrete' },
  { value: 'Steel', labelKey: 'propertyEditor.material.category.steel' },
  { value: 'Wood', labelKey: 'propertyEditor.material.category.wood' },
  { value: 'Masonry', labelKey: 'propertyEditor.material.category.masonry' },
  { value: 'Glass', labelKey: 'propertyEditor.material.category.glass' },
  { value: 'Aluminium', labelKey: 'propertyEditor.material.category.aluminium' },
  { value: 'Insulation', labelKey: 'propertyEditor.material.category.insulation' },
  { value: 'Gypsum', labelKey: 'propertyEditor.material.category.gypsum' },
  { value: 'Stone', labelKey: 'propertyEditor.material.category.stone' },
  { value: 'Ceramic', labelKey: 'propertyEditor.material.category.ceramic' },
  { value: 'Plastic', labelKey: 'propertyEditor.material.category.plastic' },
  { value: 'Composite', labelKey: 'propertyEditor.material.category.composite' },
] as const satisfies ReadonlyArray<{ value: string; labelKey: TranslationKey }>;
