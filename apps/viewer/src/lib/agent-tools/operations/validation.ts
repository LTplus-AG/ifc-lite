/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JSONSchemaType } from 'ajv';
import { operation } from './contract';
export const validationOperations = [operation<{ ids_xml: string }>({
  id: 'validation.ids', owner: 'validation', description: 'Run an inline buildingSMART IDS against the effective model through the native validation service. Use background execution for observable completion.',
  effects: ['read'], capability: 'read', implementation: 'sdk',
}, {
  type: 'object', properties: { ids_xml: { type: 'string', minLength: 1, maxLength: 2000000 } }, required: ['ids_xml'], additionalProperties: false,
} satisfies JSONSchemaType<{ ids_xml: string }>, async (i, c) => {
  if (c.model.status !== 'ready') throw new Error('IDS validation requires the loaded IFC STEP source.');
  const { validateIdsAgainst } = await import('../ids-tools');
  return (await validateIdsAgainst(c.model, i.ids_xml, c)).output.structured;
})];
