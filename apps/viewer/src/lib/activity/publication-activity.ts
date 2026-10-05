/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF publication as tray rows (U02, #6925). The outbox is durable: its
 * records live in IndexedDB and recover on boot (an entry left `sending` by a
 * closed page becomes `uncertain`, never resent and never done). The tray
 * reads those records as they are; nothing is copied into the session
 * journal, so a reload shows exactly what storage says.
 */

import type { BcfPublication, OutboxState } from '@/lib/bcf-publication/outbox-types';

export type PublicationOutcome = 'running' | 'queued' | 'completed' | 'partial' | 'failed' | 'uncertain' | 'blocked';

export interface PublicationActivity {
  id: string;
  /** Batch name, else the server project. */
  subject: string;
  outcome: PublicationOutcome;
  done: number;
  total: number;
  failed: number;
  /** Entries that need an explicit server check or resolution. */
  attention: number;
  updatedAt: string;
}

function count(states: readonly OutboxState[], state: OutboxState): number {
  return states.filter((value) => value === state).length;
}

export function publicationActivity(record: BcfPublication): PublicationActivity {
  const states = record.entries.map((entry) => entry.state);
  const done = count(states, 'done');
  const failed = count(states, 'failed');
  const uncertain = count(states, 'uncertain');
  const blocked = count(states, 'blocked');
  const total = states.length;
  const outcome: PublicationOutcome = count(states, 'sending') > 0 ? 'running'
    : uncertain > 0 ? 'uncertain'
      : blocked > 0 ? 'blocked'
        : count(states, 'queued') > 0 ? 'queued'
          : failed === 0 ? 'completed'
            : done > 0 ? 'partial' : 'failed';
  return {
    id: record.id,
    subject: record.batchName ?? record.target.projectName ?? record.target.projectId,
    outcome, done, total, failed, attention: uncertain + blocked, updatedAt: record.updatedAt,
  };
}
