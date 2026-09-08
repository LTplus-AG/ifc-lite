/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideLabelEvent, enforceLabelEvent, LabelAuthorityError } from './enforce-pipeline-labels.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'enforce-pipeline-labels.mjs');

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
  const calls = [];
  const result = enforceLabelEvent(event('unqueued', 'BIMvoice', 73), {
    cfg,
    repo: 'LTplus-AG/ifc-lite',
    spawn: (...args) => {
      calls.push(args);
      if (calls.length === 1) {
        return { status: 0, stdout: '[[{"event":"labeled","label":{"name":"unqueued"},"actor":{"login":"BIMvoice"}}]]', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.action, 'remove');
  assert.equal(result.sender, 'bimvoice');
  assert.deepEqual(calls[1].slice(0, 2), [
    'gh',
    ['api', '--method', 'DELETE', 'repos/LTplus-AG/ifc-lite/issues/73/labels/unqueued'],
  ]);
});

test('#3876: a stale unauthorized event cannot remove a maintainer reapplication', () => {
  let calls = 0;
  const result = enforceLabelEvent(event('ready', 'BIMvoice', 73), {
    cfg,
    repo: 'LTplus-AG/ifc-lite',
    spawn: () => {
      calls += 1;
      return {
        status: 0,
        stdout: '[[{"event":"labeled","label":{"name":"ready"},"actor":{"login":"BIMvoice"}},{"event":"unlabeled","label":{"name":"ready"},"actor":{"login":"louistrue"}},{"event":"labeled","label":{"name":"ready"},"actor":{"login":"louistrue"}}]]',
        stderr: '',
      };
    },
  });
  assert.equal(result.action, 'keep-newer-state');
  assert.equal(calls, 1, 'the DELETE call must not happen');
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

test('#3876: an app spelling of an authority login does not inherit its authority', () => {
  // normaliseLogin folds `app/x`, `x[bot]` and `x` onto one key, so without a
  // separate bot check every one of these reads as the maintainer and the
  // label stays attached. Asserted per spelling: one shared assertion would
  // pass while two of the three still folded through.
  for (const login of ['louistrue[bot]', 'LOUISTRUE[BOT]', 'app/louistrue']) {
    const decision = decideLabelEvent(event('ready', login, 73), cfg);
    assert.equal(decision.action, 'remove', `${login} must not be treated as the maintainer`);
  }
  // `sender.type` alone is enough, even when the login carries no bot spelling.
  assert.equal(
    decideLabelEvent({ ...event('ready', 'louistrue', 73), sender: { login: 'louistrue', type: 'Bot' } }, cfg).action,
    'remove',
  );
  // The human of that name is still an authority. Without this the test above
  // would also pass with the authority lookup deleted outright.
  assert.equal(decideLabelEvent(event('ready', 'louistrue', 73), cfg).action, 'keep');
});

test('a removal API failure is visible and never reported as enforcement', () => {
  let calls = 0;
  assert.throws(
    () => enforceLabelEvent(event('ready', 'BIMvoice'), {
      cfg,
      repo: 'LTplus-AG/ifc-lite',
      spawn: () => {
        calls += 1;
        return calls === 1
          ? { status: 0, stdout: '[[{"event":"labeled","label":{"name":"ready"},"actor":{"login":"BIMvoice"}}]]', stderr: '' }
          : { status: 1, stdout: '', stderr: 'forbidden' };
      },
    }),
    (error) => error instanceof LabelAuthorityError && error.reason === 'REMOVE_FAILED' && /forbidden/.test(error.message),
  );
});

test('#3876: an unreadable payload exits with a reason, not a stack trace', () => {
  // The `❌ REASON: message` handler is the only thing a maintainer reads in
  // the run log. An unwrapped JSON.parse threw a raw SyntaxError past it, so
  // the most likely operator error printed a Node stack trace and looked like
  // a crashed removal rather than an input nobody can parse.
  const dir = mkdtempSync(join(tmpdir(), 'label-authority-'));
  try {
    const eventPath = join(dir, 'event.json');
    writeFileSync(eventPath, 'not json at all');

    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'LTplus-AG/ifc-lite' },
    });

    assert.equal(r.status, 1);
    assert.match(r.stderr, /BAD_EVENT/);
    assert.match(r.stderr, /Could not read the webhook payload/);
    // The point of the wrap: no stack frame reaches the log.
    assert.doesNotMatch(r.stderr, /at ModuleJob\.run/, 'the error must not escape as an uncaught throw');
  } finally {
    // In a `finally`, so a failed assertion still cleans up rather than
    // leaving a temp dir behind on every red CI run.
    rmSync(dir, { recursive: true, force: true });
  }
});
