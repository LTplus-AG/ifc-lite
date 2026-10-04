/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { validateInput } from '../validate.js';
import { physicalEditTool } from './physical-edit.js';

// #6232: Align must retain the supported discriminators when joining the
// physical schema repaired for review4172820355.
it('Align requires its reference, selection and mode before native preparation (#6232)', () => {
  const valid = { kind: 'align', reference_id: 1222, express_ids: [1262], mode: 'left' };
  for (const field of ['reference_id', 'express_ids', 'mode'] as const) {
    const operation: Record<string, unknown> = { ...valid };
    delete operation[field];
    const result = validateInput(physicalEditTool.inputSchema, { operation });
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.errors)).toContain(`operation.${field}`);
  }
  for (const operation of [
    { ...valid, kind: 'unknown' }, { ...valid, mode: 'unknown' },
    { ...valid, express_ids: [] }, { ...valid, reference_id: 0 },
    { ...valid, extra: true },
  ]) expect(validateInput(physicalEditTool.inputSchema, { operation }).valid).toBe(false);
});

it('Align advertises and accepts all six complete modes (#6232)', () => {
  for (const mode of ['left', 'centre', 'right', 'top', 'middle', 'bottom']) {
    expect(validateInput(physicalEditTool.inputSchema, {
      operation: { kind: 'align', reference_id: 1222, express_ids: [1262, 1263], mode },
    }).valid).toBe(true);
  }
});
