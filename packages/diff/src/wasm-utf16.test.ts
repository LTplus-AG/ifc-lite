/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { DataFingerprintInput } from './fingerprint.js';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url);
const available = existsSync(binary) && existsSync(glue);
const strings = ['\ud800', '\udc00', '\ufffd', '\\ud800', '\ud800\udc00', '\ue000'];
test.skipIf(!available)('actual WASM preserves every model, option and lineage string code unit (#8042)', async () => {
  const wasm = await import('@ifc-lite/wasm/diff');
  wasm.initSync({ module: readFileSync(binary) });
  const model = (values: string[]) => new wasm.DiffModel(values,
    new Uint32Array(values.flatMap((_, i) => [i, i, i, i, i])),
    new Uint8Array(values.map(() => 4)), new Float64Array(values.length * 6),
    new Float64Array(values.length), new Uint32Array(values.map((_, i) => i).concat(values.length)),
    new Uint32Array(values.flatMap((_, i) => [i, i])));
  const base = model(strings);
  const head = model(strings);
  try {
    const result = base.compare(head, {}) as { entries: { key: string; changedComponents: string[]; state: string }[] };
    expect(result.entries.map(row => row.key)).toEqual(strings);
    expect(result.entries.map(row => row.state)).toEqual(strings.map(() => 'unchanged'));
    expect(base.compare(head, { excludeTypes: [strings[0]] }).entries.map((row: { key: string }) => row.key))
      .toEqual(strings.slice(1));
  } finally { base.free(); head.free(); }
  const entries = [{ base: [strings[0]], head: [strings[1]], reason: strings[0], relation: 'identity' }];
  expect(wasm.diffKeyAliasesFromLineage(entries)).toEqual([[strings[1], strings[0]]]);
  expect(wasm.diffLineageConflicts([...entries, ...entries])).toEqual([
    `base key "${strings[0]}" appears in more than one lineage entry`,
    `head key "${strings[1]}" appears in more than one lineage entry`,
  ]);
  expect(wasm.diffRekeyByLineage(strings, entries, [strings[2]], 'copy-to-all')).toEqual([
    { key: strings[0], successors: [strings[1]], relation: 'identity', orphan: false },
    { key: strings[1], successors: [strings[1]], relation: 'unchanged', orphan: false },
    { key: strings[2], successors: [], orphan: true },
    ...strings.slice(3).map(key => ({ key, successors: [key], relation: 'unchanged', orphan: false })),
  ]);
  const lineage = wasm.diffLineageOfDiff({ entries: [], appliedKeyAliases: [[strings[1], strings[0]]] }, [],
    [[strings[1], strings[0]]], []) as { entries: typeof entries; deleted: string[] };
  expect(lineage).toEqual({ entries, deleted: [] });
  // Unlike JSON.stringify, this source text contains a literal unpaired unit.
  const text = `{"base":{"hash":"${strings[0]}"},"head":{"hash":"head"},"entries":[]}`;
  expect(JSON.parse(wasm.diffCreateSidecar(text, false)).base.hash).toBe(strings[0]);
});

test.skipIf(!available)('actual WASM fingerprints retain UTF-16 input and component insertion order (#8042)', async () => {
  const wasm = await import('@ifc-lite/wasm/diff');
  wasm.initSync({ module: readFileSync(binary) });
  const cases: { name: string; input: DataFingerprintInput; hash: string; components: [string, string][] }[] = JSON.parse(
    readFileSync(new URL('../../../rust/diff/tests/fingerprint_utf16_vectors.json', import.meta.url), 'utf8'));
  expect(cases).toHaveLength(57);
  for (const entry of cases) {
    expect(wasm.diffBuildDataFingerprint(entry.input), entry.name).toBe(entry.hash);
    expect(Object.entries(wasm.diffBuildComponentFingerprints(entry.input)), entry.name).toEqual(entry.components);
  }
});
