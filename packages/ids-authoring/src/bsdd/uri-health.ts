/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * URI health (05-bsdd.md §2.4, IDS-073). A background check resolves the
 * bSDD URIs of a document, rate-limited and cached for 24 h, into a
 * `BsddUriIndex`. The lint rules IDSL-BSDD-001…003 and the gate rule
 * GATE-BSDD-001 read that index synchronously: they never call bSDD
 * themselves, and a URI not checked yet produces no finding.
 */

import type { StudioDocument } from '../document/types.js';
import type { Uuid } from '../uuid.js';
import { dictionaryUriOf } from './contract.js';
import { BsddHttpError, BsddUnavailableError, type BsddSource, type BsddUriRecord } from './types.js';

export const URI_HEALTH_TTL_MS = 24 * 60 * 60 * 1000;

/** The checked URIs. `revision` changes on every write, so caches keyed on it go stale correctly. */
export interface BsddUriIndex {
  readonly revision: number;
  get(uri: string): BsddUriRecord | undefined;
  put(record: BsddUriRecord): void;
  records(): BsddUriRecord[];
}

export function createBsddUriIndex(initial: readonly BsddUriRecord[] = []): BsddUriIndex {
  const map = new Map<string, BsddUriRecord>(initial.map((r) => [r.uri, r]));
  let revision = 0;
  return {
    get revision() {
      return revision;
    },
    get: (uri) => map.get(uri),
    put(record) {
      map.set(record.uri, record);
      revision++;
    },
    records: () => [...map.values()],
  };
}

/** Whether a URI has the bSDD identifier shape (`…/uri/<org>/<dictionary>/<version>/class|prop/…`). */
export function isBsddUri(uri: string): boolean {
  return dictionaryUriOf(uri) !== undefined;
}

export interface DocUri {
  uri: string;
  facetId: Uuid;
  specId: Uuid;
  facetType: 'property' | 'classification' | 'material';
}

/** Every bSDD URI on the document's facets, in document order. */
export function collectDocUris(doc: StudioDocument): DocUri[] {
  const out: DocUri[] = [];
  doc.ids.specifications.forEach((spec, i) => {
    const nodes = doc.nodes.specs[i];
    const facets = [
      ...spec.applicability.facets.map((facet, j) => ({ facet, facetId: nodes.applicability[j].id })),
      ...spec.requirements.map((r) => ({ facet: r.facet, facetId: r.id })),
    ];
    for (const { facet, facetId } of facets) {
      if (facet.type !== 'property' && facet.type !== 'classification' && facet.type !== 'material') continue;
      if (facet.uri && isBsddUri(facet.uri)) out.push({ uri: facet.uri, facetId, specId: spec.id, facetType: facet.type });
    }
  });
  return out;
}

export interface UriHealthOptions {
  source: BsddSource;
  index: BsddUriIndex;
  now?: () => number;
  /** A record younger than this is not checked again. Default 24 h. */
  ttlMs?: number;
  /** Pause between two requests. Default 200 ms. */
  minIntervalMs?: number;
  /** At most this many requests per run. Default 200. */
  maxChecks?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface UriHealthReport {
  /** URIs resolved in this run. */
  checked: string[];
  /** URIs skipped because their record is fresh. */
  fresh: string[];
  /** URIs bSDD answered with an unexpected HTTP error. */
  failed: { uri: string; status: number }[];
  /** URIs left for a later run (offline, rate-limited, aborted or over budget). */
  deferred: string[];
  /** Why the run stopped early, if it did. */
  stopped?: 'offline' | 'rateLimited' | 'aborted' | 'budget';
  retryAfterSeconds?: number;
}

const sleeper = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isOffline(err: unknown): boolean {
  return err instanceof BsddUnavailableError || err instanceof TypeError || (err instanceof Error && err.name === 'AbortError');
}

/**
 * Resolve the stale or unknown `uris` one at a time, pausing between
 * requests. An offline or rate-limited answer stops the run (the rest are
 * deferred, nothing is recorded for them) rather than hammering bSDD.
 */
export async function checkUriHealth(uris: readonly string[], options: UriHealthOptions): Promise<UriHealthReport> {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? URI_HEALTH_TTL_MS;
  const interval = options.minIntervalMs ?? 200;
  const budget = options.maxChecks ?? 200;
  const sleep = options.sleep ?? sleeper;
  const report: UriHealthReport = { checked: [], fresh: [], failed: [], deferred: [] };
  const todo: string[] = [];
  for (const uri of new Set(uris)) {
    const known = options.index.get(uri);
    if (known && now() - known.checkedAt < ttl) report.fresh.push(uri);
    else todo.push(uri);
  }
  let requests = 0;
  for (let i = 0; i < todo.length; i++) {
    const uri = todo[i];
    const stop = (reason: NonNullable<UriHealthReport['stopped']>) => {
      report.stopped = reason;
      report.deferred.push(...todo.slice(i));
    };
    if (options.signal?.aborted) {
      stop('aborted');
      break;
    }
    if (requests >= budget) {
      stop('budget');
      break;
    }
    if (requests > 0 && interval > 0) await sleep(interval);
    requests++;
    try {
      options.index.put(await options.source.resolveUri(uri));
      report.checked.push(uri);
    } catch (err) {
      if (err instanceof BsddHttpError && err.status === 429) {
        stop('rateLimited');
        if (err.retryAfterSeconds !== undefined) report.retryAfterSeconds = err.retryAfterSeconds;
        break;
      }
      if (err instanceof BsddHttpError) {
        report.failed.push({ uri, status: err.status });
        continue;
      }
      if (isOffline(err)) {
        stop('offline');
        break;
      }
      throw err;
    }
  }
  return report;
}
