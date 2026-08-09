/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2323: the raw-attribute editor writes STEP tokens straight back into the
 * overlay, so it is a writer and owes the reader both ISO 10303-21 doublings.
 * It doubled the apostrophe only, which means a value holding a backslash lost
 * it on the next parse now that the reader collapses `\\`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decodeIfcString } from '@ifc-lite/encoding';
import { parseRawStepInput, serializeStepToken } from './raw-step-format.js';

const Q = '\u0027'; // apostrophe
const B = '\u005C'; // reverse solidus

/** The reader half: strip the literal's quotes, un-double, decode. */
function readStepLiteral(literal: string): string {
  return decodeIfcString(literal.slice(1, -1).replace(/''/g, Q));
}

describe('serializeStepToken string escaping', () => {
  it('doubles both STEP escapes on the wire', () => {
    assert.strictEqual(serializeStepToken(`O${Q}Brien`), `${Q}O${Q}${Q}Brien${Q}`);
    assert.strictEqual(serializeStepToken(`C:${B}temp`), `${Q}C:${B}${B}temp${Q}`);
  });

  it('round trips a value through the reader unchanged', () => {
    for (const value of [
      'Wall 01',
      `O${Q}Brien`,
      `C:${B}temp`,
      `a${Q}b${B}c`,
      `end${B}`,
      `${B}X2${B}00E9${B}X0${B}`,
    ]) {
      assert.strictEqual(readStepLiteral(serializeStepToken(value)), value);
    }
  });

  it('still passes references, enums and wildcards through untouched', () => {
    assert.strictEqual(serializeStepToken('#42'), '#42');
    assert.strictEqual(serializeStepToken('.notdefined.'), '.NOTDEFINED.');
    assert.strictEqual(serializeStepToken('$'), '$');
    assert.strictEqual(serializeStepToken('*'), '*');
  });

  it('parseRawStepInput is the exact inverse of the serializer', () => {
    for (const value of [
      'Wall 01',
      `O${Q}Brien`,
      `C:${B}temp`,
      `a${Q}b${B}c`,
      `${B}X2${B}00E9${B}X0${B}`,
    ]) {
      const literal = serializeStepToken(value);
      const parsed = parseRawStepInput(literal);
      assert.ok('value' in parsed, `parses ${literal}`);
      assert.strictEqual(parsed.value, value);
      // ...and re-serializing reproduces the same on-disk literal.
      assert.strictEqual(serializeStepToken(parsed.value), literal);
    }
  });

  // The editor's value domain is LITERAL TEXT, not wire bytes. Pinning this
  // because it is the one place the pair is deliberately NOT a byte-identical
  // passthrough of what was on disk — and the tempting "fix" (decode directives
  // on the way in) would break the inverse in the other direction, since the
  // serializer cannot re-derive the author's choice of encoding.
  it('takes a pasted on-disk directive as literal text, and re-escapes it', () => {
    const onDisk = `${Q}${B}X2${B}00E9${B}X0${B}${Q}`;
    const parsed = parseRawStepInput(onDisk);
    assert.ok('value' in parsed, 'the directive literal parses');
    // Twelve literal characters, NOT the é they encode on disk.
    assert.strictEqual(parsed.value, `${B}X2${B}00E9${B}X0${B}`);
    assert.notStrictEqual(parsed.value, 'é');

    // Re-emitted with every backslash doubled, so reading it back yields the
    // same twelve characters. That is the inverse that actually holds.
    assert.strictEqual(
      serializeStepToken(parsed.value),
      `${Q}${B}${B}X2${B}${B}00E9${B}${B}X0${B}${B}${Q}`,
    );
    assert.strictEqual(readStepLiteral(serializeStepToken(parsed.value)), parsed.value);

    // Typing the character is how you get the character.
    const typed = parseRawStepInput('café');
    assert.ok('value' in typed);
    assert.strictEqual(typed.value, 'café');
    assert.strictEqual(readStepLiteral(serializeStepToken(typed.value)), 'café');
  });
});
