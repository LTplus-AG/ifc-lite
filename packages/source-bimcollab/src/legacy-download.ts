/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext } from '@ifc-lite/plugin-api';
import { BimcollabHttpError, checked, type BimcollabTransport } from './http-client.js';
import type { BimcollabSession, IndexRecord } from './types.js';

interface CachedIndex { expires: number; records: IndexRecord[] }
export interface LegacyNames {
  location: string; project: string; phases?: readonly string[]; locationGuid: string;
  /** Whether the requested version is the document's current one (default true). */
  latest?: boolean;
}

/**
 * Whether an index record belongs to the requested project. A document
 * attached to a project PHASE carries no project on the web-app record, only
 * the phase, so phase names from the public structure stand in for it. Safe
 * because the fallback only serves current versions (see download): the
 * requested document's own row is then always in the index, so a lookalike
 * makes the match ambiguous and refused rather than silently unique.
 */
export function inProject(row: IndexRecord, names: Pick<LegacyNames, 'project' | 'phases'>): boolean {
  if (row.projectName !== null) return row.projectName === names.project;
  return row.projectPhaseName !== null && (names.phases ?? []).includes(row.projectPhaseName);
}

/** An index the user cannot read is a location they cannot hold the document in. */
const NO_ACCESS = new Set([401, 403, 404]);

export class LegacyDownload {
  private readonly cache = new Map<string, CachedIndex>();
  constructor(private readonly transport: BimcollabTransport, private readonly ttl = 60_000) {}
  async download(ctx: PluginContext, session: BimcollabSession, names: LegacyNames,
    documentNumber: string, versionNumber: string, signal?: AbortSignal): Promise<Response> {
    // The web-app index lists CURRENT versions only. For an older revision the
    // requested row is never present, so any match would be another document's
    // current version that merely shares the numbers: never a safe answer.
    if (names.latest === false) {
      throw new Error('BIMcollab cannot download older versions of this document yet; open the current version, or download this one in BIMcollab.');
    }
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
    // Fail closed: a phase-attached record names only its phase, so the same
    // phase name + document number in two projects is indistinguishable here.
    // Refusing beats serving another project's model.
    if (matches.length !== 1) throw new Error(`BIMcollab legacy download requires one unique documentNumber + versionNumber match; found ${matches.length}.`
      + (matches.length > 1 ? ' The fallback cannot tell these documents apart; download it in BIMcollab.' : ''));
    const match = matches[0]!;
    if (!match.allowDownload) throw new Error('BIMcollab does not allow downloading this document.');
    if (!Number.isSafeInteger(match.versionId) || match.versionId < 1) throw new Error('BIMcollab returned an invalid numeric version id.');
    return this.transport.download(ctx, session, match.versionId, signal);
  }

  /**
   * Every index row that belongs to this project, from every readable location.
   * Names are never used to prefer one location over another (a location's
   * web-app name can differ from its public one, so a preference can pick a
   * lookalike); the caller's uniqueness check over this union decides, and
   * refuses anything ambiguous. All ten indexes must be read completely.
   */
  private async probe(ctx: PluginContext, session: BimcollabSession, names: LegacyNames,
    signal?: AbortSignal): Promise<IndexRecord[]> {
    signal?.throwIfAborted();
    const indexes = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      try {
        const result = await checked(await this.transport.index(ctx, session, i + 1, signal));
        const index = await result.json() as { records: IndexRecord[]; incomplete?: boolean };
        // A partial index could hide a duplicate: never decide on one.
        if (index.incomplete) throw new Error('BIMcollab legacy download: a location index could not be read completely.');
        return index.records;
      } catch (error) {
        // No access to a location means it cannot hold the user's document. Any
        // other failure aborts: skipping it could hide a duplicate and make an
        // ambiguous match look unique.
        if (error instanceof BimcollabHttpError && NO_ACCESS.has(error.status)) return [];
        throw error;
      }
    }));
    const rows = indexes.flat().filter(row => inProject(row, names));
    if (rows.length) return rows;
    throw new Error('BIMcollab legacy download: project not found in indexes 1–10.');
  }
}
