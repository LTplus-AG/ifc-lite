/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowDocument } from '@ifc-lite/flow';
import { createStandardRegistry } from '@ifc-lite/flow-nodes';
import { initialPlayerValues, playerFields, seedPlayerValue, validatePlayerValue, validatePlayerValues } from './player-fields.js';
import { newFlowDocument } from './persistence.js';
import { addNode, toggleInput } from './editor-ops.js';

const registry = createStandardRegistry();

/** A graph with one Player input per widget-relevant shape. */
function graph(): FlowDocument {
  let doc = newFlowDocument('player-fields');
  doc = addNode(doc, 'core.number', [0, 0]).doc; // number-1
  doc = addNode(doc, 'core.boolean', [0, 60]).doc; // boolean-1
  doc = addNode(doc, 'core.string', [0, 120]).doc; // string-1
  doc = toggleInput(doc, 'number-1', 'value', 'Number');
  doc = toggleInput(doc, 'boolean-1', 'value', 'Boolean');
  doc = toggleInput(doc, 'string-1', 'value', 'Text');
  return doc;
}

describe('playerFields', () => {
  it('resolves each declared input against its node param — kind, options and default', () => {
    const fields = playerFields(graph(), registry);
    assert.equal(fields.length, 3);
    const numberField = fields.find((f) => f.key === 'number-1.value')!;
    assert.equal(numberField.paramKind, 'number');
    assert.equal(numberField.default, 0);
    const boolField = fields.find((f) => f.key === 'boolean-1.value')!;
    assert.equal(boolField.paramKind, 'boolean');
    assert.equal(boolField.default, false);
  });

  it('an input naming a node no longer in the doc resolves with an undefined param kind, not a throw', () => {
    const doc = graph();
    const withInput = { ...doc, inputs: [...doc.inputs, { nodeId: 'ghost', param: 'x', label: 'Ghost', kind: 'scalar' as const }] };
    const fields = playerFields(withInput, registry);
    const ghost = fields.find((f) => f.key === 'ghost.x')!;
    assert.equal(ghost.paramKind, undefined);
  });
});

describe('validatePlayerValue — scalar/number', () => {
  const field = playerFields(graph(), registry).find((f) => f.key === 'number-1.value')!;

  it('accepts a numeric string', () => {
    const result = validatePlayerValue(field, '42');
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value, 42);
  });

  it('rejects non-numeric text instead of coercing it', () => {
    const result = validatePlayerValue(field, 'not a number');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.labelKey, 'flowPanel.player.error.notNumber');
  });

  it('blank falls back to the node default (never silently becomes 0) because a default exists', () => {
    const result = validatePlayerValue(field, '');
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value, undefined, 'omitted so the scheduler uses the default');
  });

  it('blank is a validation error when the field has no default', () => {
    const bareField = { ...field, default: undefined };
    const result = validatePlayerValue(bareField, '');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.labelKey, 'flowPanel.player.error.required');
  });
});

describe('validatePlayerValue — boolean and text', () => {
  const fields = playerFields(graph(), registry);
  const boolField = fields.find((f) => f.key === 'boolean-1.value')!;
  const textField = fields.find((f) => f.key === 'string-1.value')!;

  it('boolean widget value is exactly true/false, never a truthy string', () => {
    assert.equal(validatePlayerValue(boolField, true).ok && (validatePlayerValue(boolField, true) as { value: unknown }).value, true);
    const off = validatePlayerValue(boolField, false);
    assert.equal(off.ok && off.value, false);
  });

  it('text accepts any string', () => {
    const result = validatePlayerValue(textField, 'hello');
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value, 'hello');
  });
});

describe('validatePlayerValue — enum, entitySet, storey, table, file', () => {
  const baseField = playerFields(graph(), registry)[0];

  it('enum requires a value from the declared options', () => {
    const enumField = { ...baseField, input: { ...baseField.input, kind: 'enum' as const, options: ['a', 'b'] }, options: ['a', 'b'] };
    assert.equal(validatePlayerValue(enumField, '').ok, false);
    assert.equal(validatePlayerValue(enumField, 'c').ok, false);
    const good = validatePlayerValue(enumField, 'a');
    assert.equal(good.ok, true);
    assert.equal(good.ok && good.value, 'a');
  });

  it('entitySet splits newline/comma text into a trimmed array, and blank is an empty array (not an error)', () => {
    const entityField = { ...baseField, input: { ...baseField.input, kind: 'entitySet' as const } };
    const result = validatePlayerValue(entityField, 'a,b\nc');
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value, ['a', 'b', 'c']);
    const blank = validatePlayerValue(entityField, '');
    assert.equal(blank.ok, true);
    assert.deepEqual(blank.ok && blank.value, []);
  });

  it('storey requires a selection', () => {
    const storeyField = { ...baseField, input: { ...baseField.input, kind: 'storey' as const } };
    assert.equal(validatePlayerValue(storeyField, '').ok, false);
    assert.equal(validatePlayerValue(storeyField, undefined).ok, false);
    assert.equal(validatePlayerValue(storeyField, 'L1').ok, true);
  });

  it('table requires valid JSON that passes validateTable', () => {
    const tableField = { ...baseField, input: { ...baseField.input, kind: 'table' as const } };
    assert.equal(validatePlayerValue(tableField, 'not json').ok, false);
    assert.equal(validatePlayerValue(tableField, '{}').ok, false, 'missing columns/rows/key');
    const good = validatePlayerValue(tableField, JSON.stringify({ columns: [{ name: 'GlobalId', type: 'string' }], rows: [], key: 'GlobalId' }));
    assert.equal(good.ok, true);
  });

  it('file with nothing chosen is valid (optional); a non-string raw value is not', () => {
    const fileField = { ...baseField, input: { ...baseField.input, kind: 'file' as const } };
    assert.equal(validatePlayerValue(fileField, undefined).ok, true);
    assert.equal(validatePlayerValue(fileField, 'csv text').ok, true);
    const bad = validatePlayerValue(fileField, 42);
    assert.equal(bad.ok, false, 'a non-string file value is refused, not passed on');
    assert.equal(!bad.ok && bad.labelKey, 'flowPanel.player.error.unreadableFile');
  });
});

describe('seedPlayerValue / initialPlayerValues — pre-filled from defaults', () => {
  const fields = playerFields(graph(), registry);

  it('a number scalar seeds as the string form of its numeric default', () => {
    const numberField = fields.find((f) => f.key === 'number-1.value')!;
    assert.equal(seedPlayerValue(numberField), '0');
  });

  it('a boolean scalar seeds as its real boolean default', () => {
    const boolField = fields.find((f) => f.key === 'boolean-1.value')!;
    assert.equal(seedPlayerValue(boolField), false);
  });

  it('a text scalar seeds as its string default (empty string, not blank/undefined)', () => {
    const textField = fields.find((f) => f.key === 'string-1.value')!;
    assert.equal(seedPlayerValue(textField), '');
  });

  it('initialPlayerValues prefers a stored last-used value over the seeded default', () => {
    const values = initialPlayerValues(fields, { 'number-1.value': '99' });
    assert.equal(values['number-1.value'], '99');
    assert.equal(values['boolean-1.value'], false, 'unset field still seeds from its default');
  });
});

describe('validatePlayerValues', () => {
  it('collects every field error and omits blank-with-default fields from the inputs record', () => {
    const doc = graph();
    const fields = playerFields(doc, registry);
    const result = validatePlayerValues(fields, { 'number-1.value': 'nope', 'boolean-1.value': true, 'string-1.value': 'hi' });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors['number-1.value']);

    // The title's second half: a BLANK field with a declared default is left
    // out of `inputs`, so the graph runs on its default rather than receiving
    // `undefined` for that parameter.
    const blank = validatePlayerValues(fields, { 'number-1.value': '', 'boolean-1.value': true, 'string-1.value': 'hi' });
    assert.equal(blank.ok, true);
    assert.ok(blank.ok && !('number-1.value' in blank.inputs), 'blank-with-default is omitted, not sent as undefined');
  });

  it('produces a "nodeId.param" keyed record Run can hand straight to the scheduler', () => {
    const doc = graph();
    const fields = playerFields(doc, registry);
    const result = validatePlayerValues(fields, { 'number-1.value': '7', 'boolean-1.value': true, 'string-1.value': 'hi' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.inputs, { 'number-1.value': 7, 'boolean-1.value': true, 'string-1.value': 'hi' });
  });
});
