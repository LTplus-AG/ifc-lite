/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FilterRule } from '@ifc-lite/rules';

export const RULE_KIND_LABEL: Record<FilterRule['kind'], string> = {
  model: 'Model',
  modelTag: 'Model Tag',
  storey: 'Storey',
  ifcType: 'IFC Type',
  predefinedType: 'Predefined Type',
  name: 'Name',
  globalId: 'Global ID',
  attribute: 'Attribute',
  property: 'Property',
  quantity: 'Quantity',
  material: 'Material',
  classification: 'Classification',
  elevation: 'Elevation',
  type: 'Type Name',
  parent: 'Parent',
  group: 'Group',
  modelFact: 'Model fact',
  listCondition: 'List value',
};

/** Kinds only a host with its own reader can evaluate (#6190: `listCondition`
 *  needs the Lists data provider), so a builder offers them only when its
 *  `allowedKinds` names them explicitly. */
export const HOST_READ_KINDS: ReadonlySet<FilterRule['kind']> = new Set(['listCondition']);
