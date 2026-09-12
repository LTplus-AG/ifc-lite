/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createResultEmitter,
  ORACLE_CHANNEL,
  PULL_REQUEST_CHANNEL,
  resultRecord,
} from './revert-oracle-result.mjs';

test('#4109: every result identifies whether it describes the PR or the oracle', () => {
  const finding = resultRecord({
    channel: PULL_REQUEST_CHANNEL,
    verdict: 'UNOBSERVED',
    exitCode: 1,
    reason: 'tests stayed green',
  });
  const gap = resultRecord({
    channel: ORACLE_CHANNEL,
    verdict: 'ERROR',
    exitCode: 2,
    reason: 'runner missing',
  });
  assert.equal(finding.channel, 'pull-request');
  assert.equal(gap.channel, 'oracle');
  assert.equal(finding.schemaVersion, 1);
});

test('#4109: a process result emitter refuses a second JSON record', () => {
  const writes = [];
  const emitter = createResultEmitter(true, (text) => writes.push(text));
  emitter.emit(resultRecord({ channel: ORACLE_CHANNEL, verdict: 'ERROR', exitCode: 2, reason: 'first' }));
  assert.throws(
    () => emitter.emit(resultRecord({ channel: ORACLE_CHANNEL, verdict: 'ERROR', exitCode: 2, reason: 'second' })),
    /more than one JSON result/,
  );
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0]).reason, 'first');
});

test('#4109: malformed channels and exit codes refuse instead of weakening the schema', () => {
  assert.throws(
    () => resultRecord({ channel: 'unknown', verdict: 'ERROR', exitCode: 2, reason: 'bad channel' }),
    /unknown revert-oracle result channel/,
  );
  assert.throws(
    () => resultRecord({ channel: ORACLE_CHANNEL, verdict: 'ERROR', exitCode: -1, reason: 'bad exit' }),
    /invalid revert-oracle exit code/,
  );
});

test('#4109: detail fields cannot overwrite the versioned result envelope', () => {
  const record = resultRecord({
    channel: ORACLE_CHANNEL,
    verdict: 'ERROR',
    exitCode: 2,
    reason: 'canonical',
    schemaVersion: 99,
  });
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.reason, 'canonical');
});

test('#4109: disabled JSON output does not consume the one allowed emission', () => {
  const emitter = createResultEmitter(false, () => assert.fail('disabled emitter wrote output'));
  emitter.emit(resultRecord({ channel: ORACLE_CHANNEL, verdict: 'ERROR', exitCode: 2, reason: 'first' }));
  emitter.emit(resultRecord({ channel: ORACLE_CHANNEL, verdict: 'ERROR', exitCode: 2, reason: 'second' }));
  assert.equal(emitter.emitted, false);
});
