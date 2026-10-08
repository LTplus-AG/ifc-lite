/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Pure outbox transitions; every durable state change goes through one of these. */

import type { BcfPublication, OutboxBlock, OutboxEntry, OutboxFailure, OutboxReceipt } from './outbox-types.js';

export class OutboxTransitionError extends Error {
  constructor(entry: OutboxEntry, action: string) {
    super(`Outbox entry ${entry.id} cannot ${action} from ${entry.state}`);
    this.name = 'OutboxTransitionError';
  }
}

export function markSending(entry: OutboxEntry, at: string): OutboxEntry {
  if (entry.state !== 'queued') throw new OutboxTransitionError(entry, 'send');
  const { failure: _failure, check: _check, ...rest } = entry;
  return { ...rest, state: 'sending', attempts: entry.attempts + 1, sentAt: at };
}

/** A receipt is authoritative from any unresolved state: it proves the effect exists. */
export function markDone(entry: OutboxEntry, receipt: OutboxReceipt): OutboxEntry {
  if (entry.state === 'done' && entry.receipt?.remoteGuid === receipt.remoteGuid) return entry;
  if (entry.state !== 'sending' && entry.state !== 'uncertain' && entry.state !== 'blocked') {
    throw new OutboxTransitionError(entry, 'record a receipt');
  }
  const { failure: _failure, blocked: _blocked, ...rest } = entry;
  return { ...rest, state: 'done', receipt };
}

export function markFailed(entry: OutboxEntry, failure: OutboxFailure): OutboxEntry {
  if (entry.state !== 'sending' && entry.state !== 'queued' && entry.state !== 'blocked') throw new OutboxTransitionError(entry, 'fail');
  const { blocked: _blocked, ...rest } = entry;
  return { ...rest, state: 'failed', failure };
}

export function markUncertain(entry: OutboxEntry, failure: OutboxFailure): OutboxEntry {
  if (entry.state !== 'sending') throw new OutboxTransitionError(entry, 'become uncertain');
  return { ...entry, state: 'uncertain', failure };
}

export function markBlocked(entry: OutboxEntry, blocked: OutboxBlock): OutboxEntry {
  if (entry.state === 'done' || entry.state === 'sending') throw new OutboxTransitionError(entry, 'block');
  return { ...entry, state: 'blocked', blocked };
}

/**
 * Back to the queue only with evidence that nothing was applied: a definite
 * failure, or a server check that found no trace of the write. An
 * `uncertain`/imported entry with no such check is refused.
 */
export function requeue(entry: OutboxEntry): OutboxEntry {
  const checkedAbsent = entry.check?.result === 'absent';
  const allowed = entry.state === 'failed' && entry.failure?.code !== 'confirmed-absent'
    || (entry.state === 'uncertain' || entry.state === 'blocked' && entry.blocked === 'imported') && checkedAbsent;
  if (!allowed) throw new OutboxTransitionError(entry, 'requeue');
  const { failure: _failure, blocked: _blocked, ...rest } = entry;
  return { ...rest, state: 'queued' };
}

/** Entries that cannot be sent now because an entry they depend on is not done. */
export function waitingOn(record: BcfPublication, entry: OutboxEntry): OutboxEntry | undefined {
  if (!entry.dependsOn) return undefined;
  const dependency = record.entries.find(item => item.id === entry.dependsOn);
  return dependency && dependency.state === 'done' ? undefined : dependency ?? entry;
}

export function replaceEntry(record: BcfPublication, entry: OutboxEntry, at: string): BcfPublication {
  return { ...record, updatedAt: at, entries: record.entries.map(item => item.id === entry.id ? entry : item) };
}

/**
 * After a reload nothing is in flight in this tab: an entry still `sending`
 * may or may not have reached the server, so it becomes `uncertain`.
 * Entries this tab is actively sending are left alone.
 */
export function recoverInterrupted(record: BcfPublication, inFlight: ReadonlySet<string>, at: string): BcfPublication | null {
  let changed = false;
  const entries = record.entries.map(entry => {
    if (entry.state !== 'sending' || inFlight.has(entry.id)) return entry;
    changed = true;
    return markUncertain(entry, { code: 'interrupted', message: 'The page closed or reloaded while this write was being sent.', at });
  });
  return changed ? { ...record, updatedAt: at, entries } : null;
}

/**
 * A record arriving from a backup import must never dispatch on its own:
 * everything not already done or definitively failed is blocked until it is
 * checked against the server. Done receipts keep their mappings.
 */
export function quarantineImported(record: BcfPublication): BcfPublication {
  return { ...record, imported: true, entries: record.entries.map(entry =>
    entry.state === 'done' || entry.state === 'failed' ? entry : { ...entry, state: 'blocked', blocked: 'imported' }) };
}

export interface PublicationCounts { queued: number; sending: number; done: number; failed: number; uncertain: number; blocked: number }

export function publicationCounts(record: BcfPublication): PublicationCounts {
  const counts: PublicationCounts = { queued: 0, sending: 0, done: 0, failed: 0, uncertain: 0, blocked: 0 };
  for (const entry of record.entries) counts[entry.state] += 1;
  return counts;
}
