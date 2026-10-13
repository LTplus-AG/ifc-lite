/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { canonical, decodeCheck, MAX_CHECKS, record, refuse } from './bcf-publication-codec.js';
import type { StoredBcfAttempt, StoredBcfCheck } from './bcf-publication-types.js';

const MAX_EPOCH = Math.floor(Number.MAX_SAFE_INTEGER / MAX_CHECKS);
const code = (error: unknown) => record(error) ? error.code : undefined;
export interface BcfCheckEpoch { version: 1; id: string; digest: string; epoch: number; previous?: StoredBcfCheck }
export function epochOf(checkId: string): number {
  const id = Number(checkId);
  if (!Number.isSafeInteger(id) || id < 1 || String(id) !== checkId) refuse('invalid check generation');
  const epoch = Math.floor((id - 1) / MAX_CHECKS) + 1;
  if (epoch > MAX_EPOCH) refuse('check generation exceeds safe integer identity');
  return epoch;
}
function marker(value: unknown, attempt: StoredBcfAttempt, epoch: number): BcfCheckEpoch {
  if (!record(value) || value.version !== 1 || value.id !== attempt.id || value.digest !== attempt.digest || value.epoch !== epoch
    || Object.keys(value).some(k => !['version', 'id', 'digest', 'epoch', 'previous'].includes(k))) refuse('invalid recovery epoch');
  if (epoch === 1) {
    if (value.previous !== undefined) refuse('first epoch cannot have preceding proof');
  } else {
    const checkId = String((epoch - 1) * MAX_CHECKS);
    const previous = decodeCheck(value.previous, attempt, `${attempt.id}.checked-${checkId}.json`);
    if (previous.checkId !== checkId || previous.settlement) refuse('invalid preceding epoch proof');
  }
  return value as unknown as BcfCheckEpoch;
}

/** Contiguous immutable markers permit bounded lookup; archived epoch bodies are never walked. */
export async function loadCheckEpoch(attempt: StoredBcfAttempt,
  read: (epoch: number, filename: string) => Promise<unknown>): Promise<{ checks: StoredBcfCheck[]; pending: boolean }> {
  async function probe(epoch: number): Promise<BcfCheckEpoch | undefined> {
    try { return marker(await read(epoch, 'marker.json'), attempt, epoch); }
    catch (error) { if (code(error) === 'ENOENT') return undefined; throw error; }
  }
  let latest = await probe(1);
  if (!latest) return { checks: [], pending: false };
  let low = 1, high = 2;
  while (high <= MAX_EPOCH) {
    const found = await probe(high);
    if (!found) break;
    latest = found; low = high;
    if (high === MAX_EPOCH) break;
    high = Math.min(MAX_EPOCH, high * 2);
  }
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    const found = await probe(middle);
    if (found) { latest = found; low = middle; } else high = middle;
  }
  const checks = latest.previous ? [latest.previous] : [];
  let missing = false, pending = false;
  for (let offset = 1; offset <= MAX_CHECKS; offset += 1) {
    const checkId = String((latest.epoch - 1) * MAX_CHECKS + offset);
    const event = async (completed: boolean): Promise<StoredBcfCheck | undefined> => {
      const filename = `${attempt.id}.${completed ? 'checked' : 'check'}-${checkId}.json`;
      try { return decodeCheck(await read(latest!.epoch, filename), attempt, filename); }
      catch (error) { if (code(error) === 'ENOENT') return undefined; throw error; }
    };
    const request = await event(false), response = await event(true);
    if (!request) {
      if (response) refuse('check response lacks reserved transition');
      missing = true; continue;
    }
    if (missing || pending || (response && request.settlement)) refuse('noncontiguous recovery epoch');
    if (request.settlement && response) refuse('settlement cannot have a response');
    checks.push(response ?? request);
    pending = !response && !request.settlement;
  }
  return { checks, pending };
}

/** Existing marker must contain the same immutable predecessor proof. */
export function verifyCheckEpoch(value: unknown, expected: BcfCheckEpoch, attempt: StoredBcfAttempt): void {
  if (canonical(marker(value, attempt, expected.epoch)) !== canonical(expected)) refuse('epoch predecessor proof changed');
}
