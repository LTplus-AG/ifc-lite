#!/usr/bin/env tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Augment the existing EPSG index with proj4 definition strings.
 *
 * Reads the generated EPSG index, fetches proj4 strings from epsg.io,
 * and writes the updated file back.
 *
 * Usage:
 *   npx tsx scripts/augment-epsg-proj4.ts
 *   npx tsx scripts/augment-epsg-proj4.ts --concurrency=30
 *   pnpm exec tsx scripts/augment-epsg-proj4.ts --compound-codes=5832,5833,5834,5835
 *
 * --compound-codes refreshes only those registry compound records, including
 * deprecated codes absent from the index. Their XY definitions come from the
 * bundled horizontal components; no epsg.io fetch or full index refresh occurs.
 *
 * Alternative (when epsg.io is unavailable):
 *   pnpm add -D epsg epsg-index
 *   Then use the merge script in the PR description to combine both packages.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyProj4Overrides } from './epsg-proj4-overrides.js';
import { summarizeEntry, inheritCompoundProj4, indexJson, type EpsgIndexEntry as EpsgEntry, type RegistryDetail } from './epsg-registry.js';

const DEFAULT_CONCURRENCY = 30;
const GENERATED_PATH = path.resolve('packages/data/src/generated/epsg-index.generated.ts');

function parseArgs(argv: string[]): { concurrency: number; compoundCodes: string[] } {
  let concurrency = DEFAULT_CONCURRENCY;
  let compoundCodes: string[] = [];
  for (const arg of argv) {
    if (arg === '--compound-codes') throw new Error('Expected --compound-codes=CODE[,CODE...]');
    if (arg.startsWith('--compound-codes=')) {
      compoundCodes = [...new Set(arg.slice('--compound-codes='.length).split(','))];
      if (!compoundCodes.every(code => /^\d+$/.test(code))) throw new Error('Expected numeric compound codes');
    }
    if (arg.startsWith('--concurrency=')) {
      const value = Number.parseInt(arg.slice('--concurrency='.length), 10);
      if (Number.isFinite(value) && value > 0) concurrency = value;
    }
  }
  return { concurrency, compoundCodes };
}

function readExistingEntries(): { entries: EpsgEntry[]; version: string } {
  const content = fs.readFileSync(GENERATED_PATH, 'utf8');
  const jsonMatch = content.match(/EPSG_INDEX_JSON = (".*")/s);
  const versionMatch = content.match(/EPSG_INDEX_DATASET_VERSION = '([^']+)'/);
  if (!jsonMatch) throw new Error('Could not parse EPSG_INDEX_JSON from generated file');
  const json = JSON.parse(jsonMatch[1]) as string;
  return {
    entries: JSON.parse(json) as EpsgEntry[],
    version: versionMatch?.[1] ?? 'unknown',
  };
}

/** How a proj4 lookup failed to produce a usable definition. */
type Proj4Failure = 'http' | 'threw' | 'unusable-body';

const failureTally = new Map<string, number>();
const FAILURE_SAMPLES_TO_PRINT = 5;
let failureSamplesPrinted = 0;

function noteFailure(code: string, kind: Proj4Failure, detail: string): void {
  const key = `${kind}: ${detail}`;
  failureTally.set(key, (failureTally.get(key) ?? 0) + 1);
  // Flood guard: this runs once per unresolved code across ~thousands of
  // entries, so print a handful of concrete examples and let the end-of-run
  // tally carry the rest.
  if (failureSamplesPrinted < FAILURE_SAMPLES_TO_PRINT) {
    failureSamplesPrinted++;
    console.warn(`  EPSG:${code} — ${key}`);
  }
}

function reportFailures(): void {
  if (failureTally.size === 0) return;
  console.warn('\nUnresolved proj4 lookups, by cause:');
  for (const [key, count] of [...failureTally].sort((a, b) => b[1] - a[1])) {
    console.warn(`  ${count.toString().padStart(6)}  ${key}`);
  }
}

/**
 * Why every non-answer is counted and reported:
 *
 * a `null` from here is indistinguishable at the call site from "epsg.io has
 * no proj4 string for this code" — but it is also what a transport error, an
 * HTTP 429/5xx, or a captive-portal HTML body produces. This function used to
 * swallow the throw outright, so a run made during an epsg.io outage or behind
 * a rate limit finished with `N missing`, rewrote the generated module, and
 * printed nothing at all about the network. The `noteFailure` tallies are what make
 * "the registry genuinely has none" separable from "we never got an answer".
 *
 * NOTE for a maintainer: an `!resp.ok` response still returns immediately with
 * no retry, so a single 429/503 permanently records a code as having no proj4
 * for this run. `scripts/fixtures/fetch-fixtures.mjs` treats 5xx/408/429 as
 * retryable and only 4xx as permanent; adopting that policy here would be a
 * behaviour change to a hand-run generator and is left as a deliberate
 * decision rather than folded into a logging fix.
 */
async function fetchProj4(code: string, attempts = 3): Promise<string | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await fetch(`https://epsg.io/${code}.proj4`, {
        headers: { 'User-Agent': 'ifc-lite-epsg-generator/1.0' },
      });
      if (!resp.ok) {
        noteFailure(code, 'http', `HTTP ${resp.status} ${resp.statusText}`);
        return null;
      }
      const text = (await resp.text()).trim();
      if (!text || text.startsWith('<') || text.startsWith('{') || !text.includes('+')) {
        noteFailure(code, 'unusable-body', text ? `${text.slice(0, 40)}…` : '(empty)');
        return null;
      }
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise(r => setTimeout(r, 200 * attempt));
      }
    }
  }
  noteFailure(
    code,
    'threw',
    lastError instanceof Error ? lastError.message : String(lastError),
  );
  return null;
}

function renderModule(entries: EpsgEntry[], version: string): string {
  const json = indexJson(entries);
  const stringLiteral = JSON.stringify(json);

  return `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AUTO-GENERATED by \`scripts/generate-epsg-index.ts\`.
 *
 * Source: EPSG Registry API (https://apps.epsg.org/api/v1)
 * Dataset version: ${version}
 * Terms: https://epsg.org/terms-of-use.html
 *
 * Do not edit by hand. Re-run \`pnpm generate:epsg-index\` to refresh.
 */

import type { EpsgIndexEntry } from '../epsg-types.js';

export const EPSG_INDEX_DATASET_VERSION = '${version}';

const EPSG_INDEX_JSON = ${stringLiteral};

export const EPSG_INDEX: readonly EpsgIndexEntry[] = JSON.parse(EPSG_INDEX_JSON) as EpsgIndexEntry[];
`;
}

async function main(): Promise<void> {
  const { concurrency, compoundCodes } = parseArgs(process.argv.slice(2));
  const { entries, version } = readExistingEntries();

  if (compoundCodes.length) {
    const refreshed = await Promise.all(compoundCodes.map(async code => {
      const url = `https://apps.epsg.org/api/v1/CompoundCoordRefSystem/${code}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const detail = await response.json() as RegistryDetail & { Deprecations?: unknown[] };
      if (String(detail.Code) !== code || detail.Kind !== 'compound' || !detail.HorizontalCrs?.Code) {
        throw new Error(`EPSG:${code} is not a compound CRS with a horizontal component`);
      }
      return summarizeEntry({ Code: detail.Code, Name: detail.Name, Deprecated: Boolean(detail.Deprecations?.length) }, detail);
    }));
    // Correct horizontal datum operations first; never accept a compound export
    // from epsg.io when its horizontal component is already bundled (#7658).
    console.error(applyProj4Overrides(entries));
    inheritCompoundProj4(refreshed, entries);
    // Override codes skip inheritance and take their pinned definition here.
    console.error(applyProj4Overrides(refreshed));
    for (const entry of refreshed) {
      if (!entry.proj4) throw new Error(`EPSG:${entry.code}: horizontal EPSG:${entry.horizontalCode} has no bundled proj4`);
    }
    const refreshedCodes = new Set(refreshed.map(entry => entry.code));
    const merged = [...entries.filter(entry => !refreshedCodes.has(entry.code)), ...refreshed]
      .sort((a, b) => Number(a.code) - Number(b.code));
    fs.writeFileSync(GENERATED_PATH, `${renderModule(merged, version)}\n`, 'utf8');
    console.log(`Refreshed ${refreshed.length} compound CRS entries from their bundled horizontal components`);
    return;
  }

  // Filter to entries that don't already have proj4
  const needsProj4 = entries.filter(e => !e.proj4);
  console.log(`Total entries: ${entries.length}, need proj4: ${needsProj4.length}`);

  const queue = [...needsProj4];
  let resolved = 0;
  let failed = 0;

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (!entry) return;
      const def = await fetchProj4(entry.code);
      if (def) {
        entry.proj4 = def;
        resolved++;
      } else {
        failed++;
      }
      const total = resolved + failed;
      if (total % 500 === 0) {
        console.log(`  ${total}/${needsProj4.length} (${resolved} resolved, ${failed} missing)`);
      }
    }
  }

  const start = Date.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsed = Date.now() - start;

  console.log(`Done in ${elapsed}ms: ${resolved} resolved, ${failed} missing`);
  console.log(`Total entries with proj4: ${entries.filter(e => e.proj4).length}/${entries.length}`);
  reportFailures();

  // A run that resolved nothing is almost never "the registry has none" — it is
  // the network. Rewriting the generated module anyway is harmless (it round-trips
  // the same entries) but reporting only "Written to …" reads as success, so name
  // the condition before the write.
  if (needsProj4.length > 0 && resolved === 0) {
    console.warn(
      `\n⚠️  Resolved 0 of ${needsProj4.length} proj4 lookups — every request failed or ` +
        'returned nothing usable. This is almost certainly a network/upstream problem, ' +
        'not the EPSG registry. The generated file is rewritten with the entries it ' +
        'already had; re-run once epsg.io is reachable.',
    );
  }

  console.error(applyProj4Overrides(entries));
  const moduleSource = renderModule(entries, version);
  fs.writeFileSync(GENERATED_PATH, `${moduleSource}\n`, 'utf8');
  console.log(`Written to ${GENERATED_PATH}`);
}

await main();
