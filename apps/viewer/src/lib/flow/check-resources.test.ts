/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { prepareCheck, historicalJobId } from './check-resources';
import { startWorkflowRun, type WorkflowRun } from './run-session';

let run: WorkflowRun | undefined;
afterEach(() => { run?.release(); run = undefined; });
const resource = { version: 1, name: 'Check', rules: [] };

describe('check resource content identity (#6612)', () => {
  it('hashes canonical embedded JSON independent of member order', async () => {
    run = startWorkflowRun();
    const a = await prepareCheck(run, { id: 'one', enabled: true, source: { kind: 'embedded', value: resource } }, 'validation');
    const b = await prepareCheck(run, { id: 'two', enabled: true, source: { kind: 'embedded', value: { rules: [], name: 'Check', version: 1 } } }, 'validation');
    assert.equal(a.fingerprint, createHash('sha256').update('{"name":"Check","rules":[],"version":1}').digest('hex'));
    assert.equal(b.fingerprint, a.fingerprint);
    const changed = await prepareCheck(run, { id: 'three', enabled: true, source: { kind: 'embedded', value: { ...resource, name: 'Different check' } } }, 'validation');
    assert.notEqual(changed.fingerprint, a.fingerprint);
  });

  it('hashes the actual selected text, preserving the identity of file evidence', async () => {
    run = startWorkflowRun();
    const text = JSON.stringify(resource, null, 2);
    run.files.set('checks.files/rules', [new File([text], 'checks.rules.json')]);
    const check = await prepareCheck(run, { id: 'file', enabled: true, source: { kind: 'slot', slotId: 'checks.files/rules' } }, 'validation');
    assert.equal(check.fingerprint, createHash('sha256').update(text).digest('hex'));
    const embedded = await prepareCheck(run, { id: 'embedded', enabled: true, source: { kind: 'embedded', value: resource } }, 'validation');
    assert.notEqual(check.fingerprint, embedded.fingerprint, 'file text and canonical embedded JSON are distinct source evidence');
  });

  it('qualifies historical job identity across slots, duplicate files and delimiter characters', () => {
    assert.notEqual(historicalJobId('one.files/report', 0, 'report.json'), historicalJobId('two.files/report', 0, 'report.json'));
    assert.notEqual(historicalJobId('one.files/report', 0, 'report.json'), historicalJobId('one.files/report', 1, 'report.json'));
    assert.notEqual(historicalJobId('slot:0:a', 1, 'b'), historicalJobId('slot', 0, 'a:1:b'));
    assert.equal(historicalJobId('one.files/report', 0, 'report.json'), historicalJobId('one.files/report', 0, 'report.json'));
  });

  it('rejects cyclic embedded definitions before attempting hashing or native evaluation', async () => {
    run = startWorkflowRun();
    const cyclic: Record<string, unknown> = { ...resource };
    cyclic.self = cyclic;
    await assert.rejects(prepareCheck(run, { id: 'cycle', enabled: true, source: { kind: 'embedded', value: cyclic } }, 'validation'), /cycle/);
  });
});
