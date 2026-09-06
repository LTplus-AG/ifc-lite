/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FilterRule } from '@/lib/search/filter-rules';

export const RULE_KIND_LABEL: Record<FilterRule['kind'], string> = {
  model: 'Model',
  storey: 'Storey',
  ifcType: 'IFC Type',
  predefinedType: 'Predefined Type',
  name: 'Name',
  property: 'Property',
  quantity: 'Quantity',
  material: 'Material',
  classification: 'Classification',
  elevation: 'Elevation',
};
