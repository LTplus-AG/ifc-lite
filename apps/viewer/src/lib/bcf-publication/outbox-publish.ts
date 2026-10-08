/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Panel-level orchestration: plan into the durable record, then dispatch (#6896). */

import type { DraftBatch } from '../bcf-drafts/draft-types.js';
import { dispatchPublication, type DispatchOptions, type DispatchReport, type PublicationConnection } from './outbox-dispatch.js';
import { draftPublicationId, planDraftPublication, type PublicationPlan } from './outbox-plan.js';
import { mutatePublication, readPublication } from './outbox-store.js';
import type { BcfPublication, PublicationTarget } from './outbox-types.js';

/**
 * Plan against the committed record and store the plan with CAS. If another
 * tab changed the record while this one was planning, plan again from the
 * newer record rather than overwrite it. Null when storage refused.
 */
export async function planAndStore(batch: DraftBatch, target: PublicationTarget, now = new Date()): Promise<{ plan: PublicationPlan; record: BcfPublication } | null> {
  const id = draftPublicationId(batch.id, target);
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = (await readPublication(id))?.record;
    const plan = await planDraftPublication(batch, current, target, now);
    let stale = false;
    const record = await mutatePublication(id, latest => {
      stale = (latest?.updatedAt ?? null) !== (current?.updatedAt ?? null);
      return stale ? null : plan.record;
    });
    if (!stale) return record ? { plan, record } : null;
  }
  return null;
}

export async function publishDraftBatch(batch: DraftBatch, target: PublicationTarget, connection: PublicationConnection,
  options: DispatchOptions = {}): Promise<{ plan: PublicationPlan; report: DispatchReport } | null> {
  const planned = await planAndStore(batch, target, options.now?.());
  if (!planned) return null;
  return { plan: planned.plan, report: await dispatchPublication(planned.record.id, connection, options) };
}
