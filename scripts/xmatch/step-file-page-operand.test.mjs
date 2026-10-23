/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7589: the xmatch STEP scanner ends a string literal where the shared rule
 * does. The PAGE directive `\S\` takes the next character as its operand, so
 * `'Para \S\' 5'` is ONE literal; closing it at the operand re-opened a string
 * at the next quote and carried the record's real references and commas into
 * string text. Pure: `step-file.mjs` imports nothing built.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseStepFile, quote, referencesIn, rewriteReferences, serializeStepFile, splitArgs, unquote,
} from './step-file.mjs';

const PAGE_NAME = "'Para \\S\\' 5'";
const PAGE_DESCRIPTION = "'Art \\S\\' 7 #9'";

function file(data) {
  return `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

test('splitArgs keeps a PAGE-operand literal whole and splits the args after it (#7589)', () => {
  const args = `'guid',$,${PAGE_NAME},${PAGE_DESCRIPTION},#5,(#6,#7)`;
  assert.deepEqual(splitArgs(args), ['\'guid\'', '$', PAGE_NAME, PAGE_DESCRIPTION, '#5', '(#6,#7)']);
});

test('references after a PAGE-operand literal are found, ref-shaped string text is not (#7589)', () => {
  assert.deepEqual(referencesIn(`${PAGE_DESCRIPTION},#5,(#6,#7)`), [5, 6, 7]);
});

test('rewriteReferences remaps the real refs and leaves `#9` inside the string alone (#7589)', () => {
  const map = new Map([[5, 50], [9, 90]]);
  assert.equal(rewriteReferences(`${PAGE_DESCRIPTION},#5`, map), `${PAGE_DESCRIPTION},#50`);
});

test('parseStepFile frames a record holding a PAGE-operand literal and the next record (#7589)', () => {
  // The `;` after the operand ends the record under a walker that closes the
  // literal there.
  const SEMICOLON_TEXT = "'Art \\S\\' 7; #9'";
  const parsed = parseStepFile(file(
    `#1=IFCWALL('guid',$,${SEMICOLON_TEXT},#5);\n#2=IFCPOINT(#1);`,
  ));
  assert.deepEqual(parsed.statements.map((s) => [s.id, s.type]), [[1, 'IFCWALL'], [2, 'IFCPOINT']]);
  assert.equal(parsed.statements[0].args, `'guid',$,${SEMICOLON_TEXT},#5`);
  assert.equal(serializeStepFile(parsed), file(
    `#1=IFCWALL('guid',$,${SEMICOLON_TEXT},#5);\n#2=IFCPOINT(#1);`,
  ));
});

test('a literal that ends in a PAGE operand still closes at its last quote (#7589)', () => {
  assert.deepEqual(splitArgs("'5\\S\\'',#1"), ["'5\\S\\''", '#1']);
});

// #7609: the writer is the inverse of the reader. `quote()` takes raw inner STEP
// text and must leave a `\S\` operand apostrophe single, doubling the rest.
const PAGE_VECTORS = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../rust/core/tests/fixtures/step-page-directive.json', import.meta.url)),
  'utf8',
));

test('quote() writes a PAGE operand apostrophe single, the others doubled (#7609)', () => {
  assert.equal(quote("5\\S\\'"), "'5\\S\\''");
  assert.equal(quote("Para \\S\\' 5"), "'Para \\S\\' 5'");
  assert.equal(quote("\\S\\''tail"), "'\\S\\'''tail'");
  assert.equal(quote("John's"), "'John''s'");
});

test('every step-page-directive vector round-trips through unquote() and quote() (#7609)', () => {
  for (const { name, literal } of PAGE_VECTORS) {
    assert.equal(quote(unquote(literal)), literal, name);
  }
});

test('a re-quoted PAGE value stays one literal and keeps the record framing (#7609)', () => {
  for (const { name, literal } of PAGE_VECTORS) {
    // The way successor-edits renames: decode, append, re-quote.
    const renamed = quote(`${unquote(literal)} (rev B)`);
    // Ground truth from the fixture, not from unquote(): appending to the value
    // appends inside the literal, before its own closing quote.
    assert.equal(renamed, `${literal.slice(0, -1)} (rev B)'`, name);
    const args = `'guid',$,${renamed},#5`;
    assert.deepEqual(splitArgs(args), ["'guid'", '$', renamed, '#5'], name);
    const parsed = parseStepFile(file(`#1=IFCWALL(${args});\n#2=IFCPOINT(#1);`));
    assert.deepEqual(parsed.statements.map((s) => [s.id, s.type, s.args]), [
      [1, 'IFCWALL', args],
      [2, 'IFCPOINT', '#1'],
    ], name);
  }
});
