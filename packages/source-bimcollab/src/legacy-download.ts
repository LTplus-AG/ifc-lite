/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext } from '@ifc-lite/plugin-api';
import { checked, type BimcollabTransport } from './http-client.js';
import type { BimcollabSession, IndexRecord } from './types.js';

interface CachedIndex { expires: number; records: IndexRecord[] }
export interface LegacyNames { location: string; project: string; phases?: readonly string[]; locationGuid: string }

/**
 * Whether an index record belongs to the requested project. A document
 * attached to a project PHASE carries no project on the web-app record, only
 * the phase, so phase names from the public structure stand in for it.
 */
export function inProject(row: IndexRecord, names: Pick<LegacyNames, 'project' | 'phases'>): boolean {
  if (row.projectName !== null) return row.projectName === names.project;
  return row.projectPhaseName !== null && (names.phases ?? []).includes(row.projectPhaseName);
}
export class LegacyDownload {
  private readonly cache = new Map<string, CachedIndex>();
  constructor(private readonly transport: BimcollabTransport, private readonly ttl = 60_000) {}
  async download(ctx: PluginContext, session: BimcollabSession, names: LegacyNames,
    documentNumber: string, versionNumber: string, signal?: AbortSignal): Promise<Response> {
    const key = JSON.stringify([session.spaceGuid, session.spaceLabel, names.locationGuid]);
    // Expire entries eagerly so browsing many spaces does not retain their indexes.
    for (const [id, entry] of this.cache) if (entry.expires <= Date.now()) this.cache.delete(id);
    let records = this.cache.get(key)?.records;
    if (!records) {
      records = await this.probe(ctx, session, names, signal);
      this.cache.set(key, { records, expires: Date.now() + this.ttl });
    }
    // Document numbers are unique per project, not per location; the probe
    // already pinned the location, so project + number + version identifies it.
    const matches = records.filter(row => inProject(row, names)
      && row.documentNumber === documentNumber && row.versionNumber === versionNumber);
    if (matches.length !== 1) throw new Error(`BIMcollab legacy download requires one unique documentNumber + versionNumber match; found ${matches.length}.`);
    const match = matches[0]!;
    if (!match.allowDownload) throw new Error('BIMcollab does not allow downloading this document.');
    if (!Number.isSafeInteger(match.versionId) || match.versionId < 1) throw new Error('BIMcollab returned an invalid numeric version id.');
    return this.transport.download(ctx, session, match.versionId, signal);
  }

  /**
   * The numeric location whose index holds this project. The location name is
   * authoritative, and a location only qualifies if it actually holds the
   * project, so two locations sharing a name (e.g. two `Default`s) cannot
   * shadow each other. Only when no named location holds it does a
   * project match elsewhere count, and then only if exactly one location has it.
   * Returned records are scoped to the chosen location.
   */
  private async probe(ctx: PluginContext, session: BimcollabSession, names: LegacyNames,
    signal?: AbortSignal): Promise<IndexRecord[]> {
    const byProject: IndexRecord[][] = [];
    for (let locationId = 1; locationId <= 10; locationId++) {
      signal?.throwIfAborted();
      const result = await checked(await this.transport.index(ctx, session, locationId, signal));
      const { records } = await result.json() as { records: IndexRecord[] };
      const inLocation = records.filter(row => row.locationName === names.location);
      if (inLocation.some(row => inProject(row, names))) return inLocation;
      if (records.some(row => inProject(row, names))) byProject.push(records);
    }
    if (byProject.length === 1) return byProject[0]!;
    if (byProject.length > 1) throw new Error(`BIMcollab legacy download: project found in ${byProject.length} locations; cannot tell which.`);
    throw new Error('BIMcollab legacy download: location not found in indexes 1–10.');
  }
}
