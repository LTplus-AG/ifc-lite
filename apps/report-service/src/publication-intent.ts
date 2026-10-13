/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Db } from './database.js';

function deadline<T>(pending: Promise<T>, milliseconds: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error('github_publication_intent_timeout'));
      }, milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A separate committed write survives the publisher's transaction rollback. */
export async function commitPublicationIntent(db: Db, reportId: string, timeoutMs = 5000): Promise<void> {
  let expired = false;
  const connecting = db.connect().then(client => {
    if (expired) {
      client.release();
      throw new Error('github_publication_intent_timeout');
    }
    return client;
  });
  const client = await deadline(connecting, timeoutMs, () => { expired = true; });
  let destroy = false;
  try {
    // Intentionally no foreign key: publisher already owns the parent row lock.
    const result = await deadline(client.query(
      'INSERT INTO report_publication_intents(report_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING report_id',
      [reportId],
    ), timeoutMs, () => { destroy = true; });
    if (!result.rowCount) throw new Error('github_publication_review_required');
  } catch (error) {
    destroy = true;
    throw error;
  } finally {
    client.release(destroy);
  }
}
