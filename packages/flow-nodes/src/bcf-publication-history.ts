/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { canonical, credentialFree, decodeAttempt, decodeOutcome, MAX_GENERATIONS, NATIVE_METADATA, record, refuse } from './bcf-publication-codec.js';
import { ownerStatus } from './bcf-publication-owner.js';
import type { StoredBcfAttempt } from './bcf-publication-types.js';
import type { LoadedAttempt } from './bcf-publication-store.js';

/** Validate all predecessors, retaining at most selected+current payloads, never the whole journal. */
export async function loadBcfHistory(names: string[], read: (name: string) => Promise<unknown>,
  readChecks: (attempt: StoredBcfAttempt) => Promise<{ checks: LoadedAttempt['checks']; pending: boolean }>,
  targetId?: string, secrets: readonly string[] = [], visit?: (item: LoadedAttempt) => void): Promise<LoadedAttempt | undefined> {
  const intents = names.filter(name => name.endsWith('.intent.json'))
    .sort((a, b) => Number(a.slice(65).split('.')[0]) - Number(b.slice(65).split('.')[0]));
  const ids = new Set(intents.map(name => name.slice(0, -'.intent.json'.length)));
  const relatedById = new Map<string, string[]>();
  for (const name of names) {
    if (name.startsWith('.tmp-')) continue;
    const id = name.slice(0, name.indexOf('.'));
    if (!ids.has(id)) refuse('orphaned publication record');
    const related = relatedById.get(id) ?? [];
    related.push(name); relatedById.set(id, related);
  }
  let previousSettled = true;
  let generation = 0;
  let selected: LoadedAttempt | undefined;
  async function value(name: string): Promise<unknown> {
    const result = await read(name);
    credentialFree(result, secrets);
    return result;
  }
  for (const filename of intents) {
    const related = (relatedById.get(filename.slice(0, -'.intent.json'.length)) ?? [])
      .filter(name => name !== filename && !name.endsWith('.epochs'));
    // One generation has at most intent/outcome/owner records: bounded concurrent
    // reads preserve full validation without serialising every filesystem roundtrip.
    const [rawAttempt, records] = await Promise.all([value(filename),
      Promise.all(related.map(async name => [name, await value(name)] as const))]);
    const attempt = decodeAttempt(rawAttempt, filename);
    if (attempt.generation !== ++generation || generation > MAX_GENERATIONS) refuse('missing or excessive attempt generation');
    if (!previousSettled) refuse('attempt follows unresolved write');
    const item: LoadedAttempt = { attempt, checks: [], ownerStatus: NATIVE_METADATA.owner.unknown };
    for (const [name, decoded] of records) {
      if (name.endsWith('.outcome.json')) item.outcome = decodeOutcome(decoded, attempt);
      else if (name.endsWith('.owner-stopped.json')) {
        if (!record(decoded) || decoded.version !== 1 || decoded.id !== attempt.id || decoded.digest !== attempt.digest
          || decoded.assertion !== 'owner-stopped' || typeof decoded.at !== 'string' || !Number.isFinite(Date.parse(decoded.at))
          || Object.keys(decoded).some(k => !['version', 'id', 'digest', 'at', 'assertion'].includes(k))) refuse('invalid owner confirmation');
        item.ownerConfirmed = true;
      } else refuse('unrecognized root publication record');
    }
    const recovery = await readChecks(attempt);
    item.checks = recovery.checks; item.checkPending = recovery.pending;
    if (item.checks.length && item.outcome && ['done', 'failed'].includes(item.outcome.state)) refuse('settled response cannot have recovery transitions');
    for (let index = 0; index < item.checks.length; index += 1) {
      const event = item.checks[index];
      const settlement = event.settlement;
      if (!settlement) continue;
      const proof = item.checks[index - 1];
      if (index !== item.checks.length - 1 || !proof || proof.checkId !== settlement.proofCheckId
        || canonical(proof.check) !== canonical(event.check)
        || !(settlement.outcome.state === 'done'
          ? proof.check.candidates.some(candidate => candidate.guid === settlement.outcome.receipt?.remoteGuid)
          : proof.check.result === 'absent' && proof.check.candidates.length === 0)) refuse('settlement lacks latest checked proof');
      item.reconciled = settlement.outcome;
    }
    previousSettled = ['done', 'failed'].includes((item.reconciled ?? item.outcome)?.state ?? 'uncertain');
    if (!item.outcome && !item.reconciled) item.ownerStatus = await ownerStatus(item.attempt);
    visit?.(item);
    if (targetId === undefined || targetId === attempt.id) selected = item;
  }
  return selected;
}
