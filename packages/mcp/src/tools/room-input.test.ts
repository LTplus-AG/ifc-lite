/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { validateInput } from '../validate.js';
import { roomCommandTool } from './room-command.js';

// #6232 / review4172820355: the later Room tool must use the same supported
// discriminator/required-field rules as the physical tools.
for (const [command, field] of [
  [{ action: 'pick' }, 'command.point'],
  [{ action: 'update' }, 'command.expressIds'],
  [{ action: 'edit' }, 'command.operation'],
  [{ action: 'edit', operation: { kind: 'split', a: [0, 0] } }, 'operation.b'],
  [{ action: 'edit', operation: { kind: 'drag', from: [0, 0] } }, 'operation.to'],
  [{ action: 'edit', operation: { kind: 'remove' } }, 'operation.at'],
] as const) it(`Room validates missing ${field} before native preparation (#6232)`, () => {
  const result = validateInput(roomCommandTool.inputSchema, { storey_express_id: 42, command });
  expect(result.valid).toBe(false);
  expect(JSON.stringify(result.errors)).toContain(field);
});

it('Room accepts each complete action and rejects malformed edit kinds (#6232)', () => {
  for (const command of [
    { action: 'query' }, { action: 'auto' }, { action: 'footprint' },
    { action: 'pick', point: [1, 1] }, { action: 'update', expressIds: [1222] },
    { action: 'edit', operation: { kind: 'prune' } },
    { action: 'edit', operation: { kind: 'split', a: [0, 0], b: [1, 1] } },
  ]) expect(validateInput(roomCommandTool.inputSchema, { storey_express_id: 42, command }).valid).toBe(true);
  for (const operation of [{ kind: 'unknown' }, { kind: 'prune', extra: 1 }, { kind: 'split', a: [0], b: [1, 1] }]) {
    expect(validateInput(roomCommandTool.inputSchema, { storey_express_id: 42, command: { action: 'edit', operation } }).valid).toBe(false);
  }
});
