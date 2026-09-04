/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideLabelEvent, enforceLabelEvent, LabelAuthorityError } from './enforce-pipeline-labels.mjs';

const cfg = {
  readyLabel: 'ready',
  escapeLabel: 'unqueued',
  labelAuthorities: new Set(['louistrue']),
  requireLabelAuthority: true,
};
const event = (label, sender = 'louistrue', number = 42) => ({
  action: 'labeled',
  label: { name: label },
  sender: { login: sender },
  issue: { number },
});

test('#3876: a maintainer-applied protected label remains attached', () => {
  assert.deepEqual(decideLabelEvent(event('ready'), cfg), {
    action: 'keep', label: 'ready', sender: 'louistrue',
  });
});

test('#3876: an unauthorized protected label is removed from the exact issue', () => {
  let call;
  const result = enforceLabelEvent(event('unqueued', 'BIMvoice', 73), {
    cfg,
    repo: 'LTplus-AG/ifc-lite',
    spawn: (...args) => {
      call = args;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.action, 'remove');
  assert.equal(result.sender, 'bimvoice');
  assert.deepEqual(call.slice(0, 2), [
    'gh',
    ['api', '--method', 'DELETE', 'repos/LTplus-AG/ifc-lite/issues/73/labels/unqueued'],
  ]);
});

test('ordinary labels are outside this narrow authority policy', () => {
  assert.deepEqual(decideLabelEvent(event('bug', 'BIMvoice'), cfg), {
    action: 'ignore', reason: 'UNPROTECTED_LABEL',
  });
});

test('a malformed protected-label event fails closed', () => {
  assert.throws(
    () => decideLabelEvent({ action: 'labeled', label: { name: 'ready' }, sender: null }, cfg),
    (error) => error instanceof LabelAuthorityError && error.reason === 'UNKNOWN_SENDER',
  );
});

test('the guard cannot silently survive its authority policy being disabled', () => {
  assert.throws(
    () => decideLabelEvent(event('ready'), { ...cfg, requireLabelAuthority: false }),
    (error) => error instanceof LabelAuthorityError && error.reason === 'BAD_CONFIG',
  );
});

test('a removal API failure is visible and never reported as enforcement', () => {
  assert.throws(
    () => enforceLabelEvent(event('ready', 'BIMvoice'), {
      cfg,
      repo: 'LTplus-AG/ifc-lite',
      spawn: () => ({ status: 1, stdout: '', stderr: 'forbidden' }),
    }),
    (error) => error instanceof LabelAuthorityError && error.reason === 'REMOVE_FAILED' && /forbidden/.test(error.message),
  );
});
