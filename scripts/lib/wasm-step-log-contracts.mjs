/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `exportStep(bytes, schema, included, mutationsJson)` with a mutation LOG
// (#5941), across the real wasm boundary. The expectations are the shared
// parity vectors the TypeScript `StepExporter` wrote
// (`rust/export/tests/fixtures/step_log_parity_vectors.json`), so this pins the
// shipped binding, not only the crate function behind it. The binding takes no
// time stamp, so `FILE_NAME` (which carries it) is the one line not compared.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(ROOT, 'rust/export/tests/fixtures/step_log_parity_vectors.json');

function normalise(lines, maxId) {
  return lines
    .filter((line) => !line.startsWith('FILE_NAME('))
    .map((line) => {
      const m = /^#(\d+)=IFC\w+\('([0-9A-Za-z_$]{22})'/.exec(line);
      return m && Number(m[1]) > maxId ? line.replace(m[2], '<GUID>') : line;
    });
}

export function runStepLogContracts(api, test) {
  console.log('\n📋 exportStep with a mutation log (#5941)');
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  test(`writes every shared parity case as the TypeScript exporter does (${fixture.cases.length} cases)`, () => {
    for (const c of fixture.cases) {
      const source = fixture.sources[c.source];
      const bytes = encoder.encode(`${source.join('\n')}\n`);
      const maxId = Math.max(...source.map((l) => Number(/^#(\d+)=/.exec(l)?.[1] ?? 0)));
      const out = decoder.decode(api.exportStep(bytes, c.schema ?? '', undefined, JSON.stringify(c.log))).split('\n');
      if (out[out.length - 1] === '') out.pop();
      assert.deepEqual(normalise(out, maxId), normalise(c.expected, maxId), c.name);
    }
  });

  const walls = encoder.encode(`${fixture.sources.walls.join('\n')}\n`);
  const log = fixture.cases.find((c) => c.name === 'update-property-in-existing-set').log;

  test('a log does not combine with the older payload keys', () => {
    const mixed = JSON.stringify({ ...log, attributeUpdates: [] });
    assert.throws(() => api.exportStep(walls, '', undefined, mixed), /exportStep:.*cannot be combined/);
  });

  test('a log does not combine with an isolation set', () => {
    assert.throws(() => api.exportStep(walls, '', new Uint32Array([21]), JSON.stringify(log)), /exportStep:.*included/);
  });

  test('a log carrying a kind the writer does not apply is refused, not dropped', () => {
    const unsupported = { mutations: [{ id: 'x', type: 'UPDATE_ENTITY_TYPE', timestamp: 0, modelId: 'm', entityId: 21, entityType: 'IfcColumn' }] };
    assert.throws(() => api.exportStep(walls, '', undefined, JSON.stringify(unsupported)), /exportStep:.*not supported/);
  });

  test(`refuses every shared refused case (${fixture.refusedCases.length} cases)`, () => {
    for (const c of fixture.refusedCases) {
      const bytes = encoder.encode(`${fixture.sources[c.source].join('\n')}\n`);
      assert.throws(() => api.exportStep(bytes, '', undefined, JSON.stringify(c.log)), (e) => String(e.message).includes(c.error), c.name);
    }
  });

  test('the older payload shape still applies its edits', () => {
    const legacy = JSON.stringify({ attributeUpdates: [{ expressId: 21, index: 2, value: "'Legacy'" }] });
    const out = decoder.decode(api.exportStep(walls, '', undefined, legacy));
    assert.match(out, /#21=IFCWALL\('3nZ2y9nY9FExK3Wg9nLvXz',#5,'Legacy'/);
  });
}
