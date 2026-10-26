// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireCases, wireText } from './wire-cases.mjs';
import { parseWire } from './json.mjs';
import { decode, validateShape } from './validate.mjs';
import { schema } from './schema.mjs';
for (const item of wireCases) test(`#7955 raw ${item.name}`, () => {
  const run = () => {
    const text = wireText(item);
    if (item.root === 'Envelope') return parseWire(text, schema.maxWireBytes, schema.maxWireDepth);
    if (item.root.startsWith('Shape:') || item.root === 'Binding') {
      return validateShape(item.root.replace('Shape:', ''), parseWire(text, schema.maxWireBytes, schema.maxWireDepth));
    }
    return decode(item.root, text, item.binding);
  };
  if (item.valid) assert.doesNotThrow(run);
  else assert.throws(run, /Retained contract:/u);
});

for (const item of wireCases.filter((entry) => entry.expectedBits)) {
  test(`#7955 W1 exact binary64 ${item.name}`, () => {
    const result = decode('Options', wireText(item));
    const bytes = Buffer.alloc(8); bytes.writeDoubleBE(result.chordToleranceMetres);
    assert.equal(bytes.toString('hex'), item.expectedBits, `decoded exact value: ${item.name}`);
  });
}
