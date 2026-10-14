/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNightHistory, type NightAttempt } from './frame-gpu-night-history.js';
import { sha256 } from './frame-gpu-night-profile.js';

function durableFile(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export interface AttemptHandle {
  directory: string;
  mayLaunch: boolean;
  initial: NightAttempt;
}

/**
 * Reserve one launch per UTC date before any browser spawn. The claim is never
 * removed, including after refusal or failure. Every invocation gets a record;
 * duplicate invocations refuse and prevent cherry-picked calendar acceptance.
 * An interrupted invocation remains a failed record with an immutable receipt.
 */
export function beginNightAttempt(root: string, profileSha256: string, now = new Date()): AttemptHandle {
  const startedAt = now.toISOString(), night = startedAt.slice(0, 10);
  const initial: NightAttempt = {
    night, startedAt, finishedAt: startedAt, profileSha256, status: 'failed', receiptSha256: '0'.repeat(64),
  };
  decodeNightHistory([initial]);
  mkdirSync(join(root, 'claims'), { recursive: true });
  mkdirSync(join(root, 'attempts'), { recursive: true });
  const directory = join(root, 'attempts', `${night}-${randomUUID()}`);
  mkdirSync(directory);
  let mayLaunch = true;
  try { durableFile(join(root, 'claims', `${night}.json`), json({ directory, profileSha256, startedAt })); }
  catch (error) {
    if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'EEXIST') throw error;
    mayLaunch = false;
  }
  const receipt = json({ startedAt, night, profileSha256, outcome: mayLaunch ? 'incomplete' : 'refused',
    reason: mayLaunch ? 'invocation did not complete' : 'UTC night already reserved; browser launch refused' });
  durableFile(join(directory, 'initial-receipt.json'), receipt);
  initial.receiptSha256 = sha256(receipt);
  if (!mayLaunch) initial.status = 'refused';
  durableFile(join(directory, 'attempt.json'), json(initial));
  syncDirectory(directory);
  syncDirectory(join(root, 'claims'));
  syncDirectory(join(root, 'attempts'));
  return { directory, mayLaunch, initial };
}

/** Replace only this invocation's initial record; preserve both immutable raw receipts. */
export function finishNightAttempt(handle: AttemptHandle, status: NightAttempt['status'], receipt: Uint8Array, now = new Date()): NightAttempt {
  if (!handle.mayLaunch) throw new Error('duplicate nightly invocation cannot be upgraded');
  const attempt: NightAttempt = { ...handle.initial, status, finishedAt: now.toISOString(), receiptSha256: sha256(receipt) };
  decodeNightHistory([attempt]);
  // Exclusive completion file also prevents a second completion from replacing
  // an earlier failed/refused outcome after a retry in the same invocation.
  durableFile(join(handle.directory, 'completed-receipt.json'), receipt);
  durableFile(join(handle.directory, 'attempt.next.json'), json(attempt));
  renameSync(join(handle.directory, 'attempt.next.json'), join(handle.directory, 'attempt.json'));
  syncDirectory(handle.directory);
  return attempt;
}

export function readNightAttempts(root: string): NightAttempt[] {
  return decodeNightHistory(readdirSync(join(root, 'attempts'), { withFileTypes: true }).map((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('invalid nightly attempt entry');
    const directory = join(root, 'attempts', entry.name);
    const rows = decodeNightHistory([JSON.parse(readFileSync(join(directory, 'attempt.json'), 'utf8')) as unknown]);
    const row = rows[0];
    const receipt = readFileSync(join(directory, row.receiptSha256 === sha256(readFileSync(join(directory, 'initial-receipt.json')))
      ? 'initial-receipt.json' : 'completed-receipt.json'));
    if (sha256(receipt) !== row.receiptSha256) throw new Error('night attempt raw receipt changed');
    return row;
  }));
}
