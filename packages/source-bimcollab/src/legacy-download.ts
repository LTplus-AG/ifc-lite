/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext } from '@ifc-lite/plugin-api';
import { checked, type BimcollabTransport } from './http-client.js';
import type { BimcollabSession, IndexRecord } from './types.js';

interface CachedIndex { expires: number; records: IndexRecord[] }
export class LegacyDownload {
  private readonly cache = new Map<string, CachedIndex>();
  constructor(private readonly transport: BimcollabTransport, private readonly ttl = 60_000) {}
  async download(ctx: PluginContext, session: BimcollabSession, names: { location: string; project: string; locationGuid: string },
    documentNumber: string, versionNumber: string, signal?: AbortSignal): Promise<Response> {
    const key = JSON.stringify([session.spaceGuid, session.spaceLabel, names.locationGuid]);
    // Expire entries eagerly so browsing many spaces does not retain their indexes.
    for (const [id, entry] of this.cache) if (entry.expires <= Date.now()) this.cache.delete(id);
    let records = this.cache.get(key)?.records;
    if (!records) {
      for (let locationId = 1; locationId <= 10; locationId++) {
        signal?.throwIfAborted();
        const result = await checked(await this.transport.index(ctx, session, locationId, signal));
        const index = await result.json() as { records: IndexRecord[] };
        if (index.records.some(row => row.locationName === names.location || row.projectName === names.project)) {
          records = index.records;
          this.cache.set(key, { records, expires: Date.now() + this.ttl });
          break;
        }
      }
    }
    if (!records) throw new Error('BIMcollab legacy download: location not found in indexes 1–10.');
    // Document numbers are unique per project, not per location: scope to the
    // requested project first so two projects' `D1 v1` are never conflated.
    const matches = records.filter(row => row.projectName === names.project
      && row.documentNumber === documentNumber && row.versionNumber === versionNumber);
    if (matches.length !== 1) throw new Error(`BIMcollab legacy download requires one unique documentNumber + versionNumber match; found ${matches.length}.`);
    const match = matches[0]!;
    if (!match.allowDownload) throw new Error('BIMcollab does not allow downloading this document.');
    if (!Number.isSafeInteger(match.versionId) || match.versionId < 1) throw new Error('BIMcollab returned an invalid numeric version id.');
    return this.transport.download(ctx, session, match.versionId, signal);
  }
}
