/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The oracle reports two different subjects. A pull-request result says what
 * the measurement established about the changed tests. An oracle result says
 * that the measuring instrument could not establish that result. Keeping this
 * discriminator in every JSON record prevents a capability gap from being
 * rendered as a finding about the submitter (#4109).
 */
export const PULL_REQUEST_CHANNEL = 'pull-request';
export const ORACLE_CHANNEL = 'oracle';

export function resultRecord({
  channel,
  verdict,
  exitCode,
  reason,
  base = null,
  head = null,
  production = [],
  tests = [],
  invocationId = null,
  startedAt = null,
  finishedAt = null,
  restoration = 'not-required',
  ...details
}) {
  if (channel !== PULL_REQUEST_CHANNEL && channel !== ORACLE_CHANNEL) {
    throw new Error(`unknown revert-oracle result channel: ${channel}`);
  }
  if (!Number.isInteger(exitCode) || exitCode < 0) {
    throw new Error(`invalid revert-oracle exit code: ${exitCode}`);
  }
  return {
    ...details,
    schemaVersion: 2,
    channel,
    verdict,
    exitCode,
    reason,
    base,
    head,
    production,
    tests,
    invocationId,
    timing: { startedAt, finishedAt },
    restoration,
  };
}

/** Emit at most one JSON record for a process invocation. */
export function createResultEmitter(enabled, write = console.log) {
  let emitted = false;
  return {
    emit(record) {
      if (!enabled) return;
      if (emitted) throw new Error('revert-oracle attempted to emit more than one JSON result');
      emitted = true;
      write(JSON.stringify(record, null, 2));
    },
    get emitted() {
      return emitted;
    },
  };
}
