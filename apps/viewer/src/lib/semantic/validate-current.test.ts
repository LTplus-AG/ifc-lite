/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { validateCurrentSemantic } from './validate-current';
import { useSemanticSession } from './session';
import { pilotDocument } from './demo';
import { executeValidation } from './validation-job';
it('native semantic validation reports the actual pilot dataset and never publishes across a changed graph (#10525)', async () => {
  useSemanticSession.getState().setDocument(pilotDocument());
  const valid = await validateCurrentSemantic(false, new AbortController().signal, executeValidation);
  assert.ok(valid.report); assert.equal(useSemanticSession.getState().report, valid.report);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const pending = validateCurrentSemantic(false, new AbortController().signal, async job => {
    await waiting; return executeValidation(job);
  });
  useSemanticSession.getState().setGraph('<urn:changed> <urn:predicate> <urn:value> .'); release();
  await assert.rejects(pending, /inputs changed/);
  assert.equal(useSemanticSession.getState().report, undefined);
  assert.deepEqual(useSemanticSession.getState().findings, []);
});
it('semantic cancellation and revoked commit keep prior findings unchanged (#10525)', async () => {
  useSemanticSession.getState().setDocument(pilotDocument());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(validateCurrentSemantic(false, controller.signal, executeValidation), /cancelled/);
  await assert.rejects(validateCurrentSemantic(false, new AbortController().signal, executeValidation, () => { throw new Error('Grant revoked'); }), /Grant revoked/);
  assert.equal(useSemanticSession.getState().report, undefined);
});
