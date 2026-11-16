/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { viewerOperation } from './registry';
import { expectedInputShape } from './input-errors';

const message = (id: string, input: unknown): string => {
  try { viewerOperation(id).validate(input); } catch (error) { return (error as Error).message; }
  return assert.fail(`${id} accepted ${JSON.stringify(input)}`);
};

describe('operation input errors tell the agent what is expected', () => {
  it('names the missing property, the expected shape and how to describe it', () => {
    assert.equal(message('exports.screenshot', {}),
      'Invalid exports.screenshot input: input.scope is required. Expected input (* = required): { scope*: "current-view" }. '
      + 'Describe it with viewer_operations {"operation_id":"exports.screenshot"}.');
  });

  it('names an unknown property and a wrong const value by path', () => {
    assert.match(message('exports.screenshot', { scope: 'current-view', extra: 1 }), /input\.extra is not an accepted property/);
    assert.match(message('exports.screenshot', { scope: 'all' }), /input\.scope must be "current-view"/);
  });

  it('summarizes enums, arrays and nested objects compactly', () => {
    const shape = expectedInputShape({ type: 'object', required: ['ids'], properties: {
      ids: { type: 'array', items: { type: 'integer' } }, mode: { type: 'string', enum: ['a', 'b'] },
      at: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] }, value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    } });
    assert.equal(shape, '{ ids*: integer[], mode: "a" | "b", at: { x*: number }, value: string | null }');
  });
});
