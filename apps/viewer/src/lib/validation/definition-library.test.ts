/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseIDS } from '@ifc-lite/ids';
import { parseRuleSetFile } from '@ifc-lite/rules';
import {
  checkDefinitionLibrary, emptyDefinitionLibrary, loadDefinitionLibrary,
  saveDefinitionLibrary, type DefinitionLibrary,
} from './definition-library.js';

const key = 'ifc-lite:validation:definition-library';
const xml = readFileSync(new URL('../../../public/samples/building-architecture.ids', import.meta.url), 'utf8');
const document = parseIDS(xml);
const parsedRules = parseRuleSetFile({ version: 1, name: 'Same title', rules: [] });
assert.ok(parsedRules.ok);
const rules = parsedRules.file;
function sources(): DefinitionLibrary {
  return { version: 1, active: { rules: 'rules-a', ids: 'ids-b' }, entries: [
    { id: 'rules-a', kind: 'rules', file: rules }, { id: 'rules-b', kind: 'rules', file: structuredClone(rules) },
    { id: 'ids-a', kind: 'ids', xml, document }, { id: 'ids-b', kind: 'ids', xml, document },
  ] };
}
beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

it('#6567 restores same-title definitions by UUID and exact original IDS XML through canonical parsers', () => {
  const library = sources();
  assert.equal(saveDefinitionLibrary(library, true), null);
  const stored = localStorage.getItem(key);
  assert.ok(stored);
  assert.equal(stored.includes('"document"'), false, 'derived IDS projections are not a second persisted authority');
  const restored = loadDefinitionLibrary();
  assert.equal(restored.error, null);
  assert.deepEqual(restored.library.active, library.active);
  assert.deepEqual(restored.library.entries.map(entry => entry.id), ['rules-a', 'rules-b', 'ids-a', 'ids-b']);
  for (const entry of restored.library.entries) {
    if (entry.kind === 'ids') {
      assert.equal(entry.xml, xml, 'lossless download source preserves original XML, including all namespace and formatting bytes');
      assert.deepEqual(entry.document.specifications, document.specifications);
    } else assert.deepEqual(entry.file, rules);
  }
});

it('#6567 does not overwrite the last restorable sources with an incomplete edited rule draft', () => {
  const library = sources();
  assert.equal(saveDefinitionLibrary(library, true), null);
  const before = localStorage.getItem(key);
  const incomplete = { ...library, entries: library.entries.map(entry => entry.kind === 'rules' && entry.id === 'rules-a'
    ? { ...entry, file: { ...entry.file, name: '' } } : entry) };
  assert.match(saveDefinitionLibrary(incomplete, true) ?? '', /Complete the rule set/);
  assert.equal(localStorage.getItem(key), before, 'all prior rule and IDS source records survive a transient invalid editor state');
  assert.deepEqual(loadDefinitionLibrary().library, library);
});

it('#6567 refuses a full library before storage mutation instead of silently evicting older checks', () => {
  const library = sources();
  assert.equal(saveDefinitionLibrary(library, true), null);
  const before = localStorage.getItem(key);
  const full: DefinitionLibrary = { ...library, entries: Array.from({ length: 101 }, (_, index) => ({ id: `check-${index}`, kind: 'rules', file: rules })) };
  assert.match(checkDefinitionLibrary(full) ?? '', /full/);
  assert.match(saveDefinitionLibrary(full, true) ?? '', /full/);
  assert.equal(localStorage.getItem(key), before);
});

it('#6567 preserves unreadable duplicate-ID source bytes before allowing a fresh library', () => {
  const raw = JSON.stringify({ version: 1, active: { rules: 'same', ids: null }, entries: [
    { id: 'same', kind: 'rules', file: rules }, { id: 'same', kind: 'rules', file: rules },
  ] });
  localStorage.setItem(key, raw);
  const recovered = loadDefinitionLibrary();
  assert.match(recovered.error ?? '', /backed up/);
  assert.deepEqual(recovered.library, emptyDefinitionLibrary());
  assert.equal(localStorage.getItem(`${key}:unreadable`), raw);
  assert.equal(saveDefinitionLibrary(sources(), recovered.writable), null);
  assert.equal(localStorage.getItem(`${key}:unreadable`), raw, 'the original evidence survives the next ordinary save');
});
