#!/usr/bin/env tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate the committed EPSG index artifact used for local CRS search.
 *
 * This script talks to the live EPSG Registry API intentionally, but only when
 * run explicitly. Normal package builds consume the checked-in generated file.
 *
 * Usage:
 *   npx tsx scripts/generate-epsg-index.ts
 *   npx tsx scripts/generate-epsg-index.ts --limit=250 --stdout
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

type RegistryLink = {
  rel?: string;
  href?: string;
};

type RegistrySummary = {
  Code: number;
  Name: string;
  Type?: string;
  Area?: string;
  Remarks?: string;
  Deprecated?: boolean;
  Superseded?: boolean;
  Links?: RegistryLink[];
};

type RegistryUsage = {
  Name?: string;
  ScopeDetails?: string;
};

type RegistryAlias = {
  Alias?: string;
};

type RegistryNamedRef = {
  Name?: string;
};

type RegistryDetail = {
  Code: number;
  Name: string;
  Kind?: string;
  Usage?: RegistryUsage[];
  Alias?: RegistryAlias[];
  Datum?: RegistryNamedRef;
  DatumEnsemble?: RegistryNamedRef;
  BaseCoordRefSystem?: RegistryNamedRef;
  Projection?: RegistryNamedRef;
  Conversion?: RegistryNamedRef;
  CoordSys?: RegistryNamedRef;
  HorizontalCrs?: RegistryNamedRef;
  VerticalCrs?: RegistryNamedRef;
};

type RegistryPage = {
  Results: RegistrySummary[];
  Count: number;
  Page: number;
  PageSize: number;
  TotalResults: number;
};

type EpsgIndexEntry = {
  code: string;
  name: string;
  kind: string;
  area: string;
  scope: string;
  datum: string;
  projection: string;
  unit: string;
  deprecated: boolean;
  aliases: string[];
  searchText: string;
  proj4?: string;
};

type CliOptions = {
  concurrency: number;
  limit: number | null;
  out: string;
  pageSize: number;
  stdout: boolean;
};

const API_BASE_URL = 'https://apps.epsg.org/api/v1';
const DEFAULT_CONCURRENCY = 20;
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_OUTPUT_PATH = path.resolve('packages/data/src/generated/epsg-index.generated.ts');
const EPSG_DATASET_VERSION = '12.054';

function parseArgs(argv: string[]): CliOptions {
  let concurrency = DEFAULT_CONCURRENCY;
  let limit: number | null = null;
  let out = DEFAULT_OUTPUT_PATH;
  let pageSize = DEFAULT_PAGE_SIZE;
  let stdout = false;

  for (const arg of argv) {
    if (arg.startsWith('--concurrency=')) {
      const value = Number.parseInt(arg.slice('--concurrency='.length), 10);
      if (Number.isFinite(value) && value > 0) concurrency = value;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const value = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(value) && value > 0) limit = value;
      continue;
    }
    if (arg.startsWith('--out=')) {
      out = path.resolve(arg.slice('--out='.length));
      continue;
    }
    if (arg.startsWith('--page-size=')) {
      const value = Number.parseInt(arg.slice('--page-size='.length), 10);
      if (Number.isFinite(value) && value > 0) pageSize = value;
      continue;
    }
    if (arg === '--stdout') {
      stdout = true;
      continue;
    }
  }

  return { concurrency, limit, out, pageSize, stdout };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ifc-lite-epsg-generator/1.0',
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json() as Promise<T>;
}

function normalizeKind(kind: string | undefined): string {
  const value = (kind ?? '').toLowerCase();
  if (value.includes('projected')) return 'Projected';
  if (value.includes('geographic') || value.includes('geodetic')) return 'Geographic';
  if (value.includes('compound')) return 'Compound';
  if (value.includes('vertical')) return 'Vertical';
  if (value.includes('engineering')) return 'Engineering';
  if (value.includes('geocentric')) return 'Geocentric';
  if (value.includes('derived')) return 'Derived';
  return kind?.trim() || 'Unknown';
}

function extractUnit(coordSysName: string | undefined): string {
  if (!coordSysName) return '';
  const match = /UoM:\s*([^.,]+)/i.exec(coordSysName);
  return match?.[1]?.trim() ?? '';
}

function buildSearchText(parts: Array<string | undefined>): string {
  return parts
    .flatMap(part => (part ?? '').split(/\s+/))
    .map(token => token.trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function summarizeEntry(summary: RegistrySummary, detail: RegistryDetail): EpsgIndexEntry {
  const usage = detail.Usage?.[0];
  const aliases = (detail.Alias ?? [])
    .map(alias => alias.Alias?.trim() ?? '')
    .filter(Boolean);
  const kind = normalizeKind(detail.Kind ?? summary.Type);

  const datum =
    detail.Datum?.Name?.trim() ??
    detail.DatumEnsemble?.Name?.trim() ??
    detail.BaseCoordRefSystem?.Name?.trim() ??
    detail.HorizontalCrs?.Name?.trim() ??
    detail.VerticalCrs?.Name?.trim() ??
    '';

  const projection = kind === 'Projected'
    ? (detail.Projection?.Name?.trim() ?? detail.Conversion?.Name?.trim() ?? '')
    : '';

  const area = usage?.Name?.trim() || summary.Area?.trim() || '';
  const scope = usage?.ScopeDetails?.trim() || summary.Remarks?.trim() || '';
  const unit = extractUnit(detail.CoordSys?.Name);

  return {
    code: String(detail.Code),
    name: detail.Name.trim(),
    kind,
    area,
    scope,
    datum,
    projection,
    unit,
    deprecated: Boolean(summary.Deprecated),
    aliases,
    searchText: buildSearchText([
      String(detail.Code),
      detail.Name,
      area,
      scope,
      datum,
      projection,
      unit,
      ...aliases,
    ]),
  };
}

async function fetchAllSummaries(pageSize: number): Promise<RegistrySummary[]> {
  const firstPage = await fetchJson<RegistryPage>(`${API_BASE_URL}/CoordRefSystem?pageSize=${pageSize}&page=0`);
  const totalPages = Math.ceil(firstPage.TotalResults / pageSize);
  const remainingPages = await Promise.all(
    Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) =>
      fetchJson<RegistryPage>(`${API_BASE_URL}/CoordRefSystem?pageSize=${pageSize}&page=${index + 1}`),
    ),
  );

  return [firstPage, ...remainingPages].flatMap(page => page.Results);
}

async function fetchEntries(summaries: RegistrySummary[], concurrency: number): Promise<EpsgIndexEntry[]> {
  const queue = [...summaries];
  const output: EpsgIndexEntry[] = [];

  async function fetchJsonWithRetry<T>(url: string, attempts = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fetchJson<T>(url);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await new Promise(resolve => setTimeout(resolve, 250 * attempt));
        }
      }
    }
    throw lastError;
  }

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const summary = queue.shift();
      if (!summary) return;
      try {
        const detailUrl =
          summary.Links?.find(link => link.rel === 'result')?.href ??
          `${API_BASE_URL}/CoordRefSystem/${summary.Code}`;
        const detail = await fetchJsonWithRetry<RegistryDetail>(detailUrl);
        output.push(summarizeEntry(summary, detail));
      } catch (error) {
        console.warn(`Skipping EPSG:${summary.Code} after repeated detail fetch failures`, error);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  output.sort((a, b) => Number.parseInt(a.code, 10) - Number.parseInt(b.code, 10));
  return output;
}

/**
 * Fetch proj4 definition strings from epsg.io for all entries.
 * Uses concurrent workers with retries. Entries without a valid
 * proj4 definition are left with proj4=undefined.
 *
 * `+towgs84=` sign convention (read this before re-running this script):
 *
 * EPSG registers each datum's 7-parameter Helmert transformation under one of
 * two conventions — Position Vector (method 9606) or Coordinate Frame rotation
 * (method 9607) — which are related by negating all three rotation terms
 * (tX/tY/tZ and the scale term dS are identical either way). proj4's
 * `+towgs84=` parameter is hard-coded to the Position Vector convention; a
 * Coordinate-Frame-convention rotation dropped in unchanged silently produces
 * a mispositioned (but plausible-looking) transform.
 *
 * epsg.io's `.proj4` output is not consistently one convention. Verified
 * 2026-08-19 against the EPSG Registry API's own method-labelled parameter
 * records, with proj4js round-trip residuals against independently-known
 * landmark coordinates:
 *   - EPSG:31370 (Belgian Lambert 72): epsg.io's rotation signs did not match
 *     EPSG:1652 "BD72 to ETRS89 (1)" (method 9606) negated correctly — a prior
 *     vendored fetch had picked up the Coordinate-Frame-signed variant
 *     (~65 m residual); the Position-Vector-signed variant is correct (~0.1 m).
 *   - EPSG:3021 (Sweden RT90): EPSG:1896 "RT90 to WGS 84 (2)" is published
 *     under method 9607 (Coordinate Frame); proj4's +towgs84 needs the
 *     negation of those signs (~256 m residual with the raw 9607 signs vs
 *     ~0 m negated).
 *   - EPSG:2065 (S-JTSK (Ferro) / Krovak): epsg.io sometimes omits +towgs84
 *     for this CRS entirely, which silently disables the datum shift
 *     (~117 m residual at Prague vs ~0 m with EPSG:5239 "S-JTSK to WGS 84 (5)",
 *     method 9607, negated to Position Vector).
 *
 * There is no way to detect this class of bug from the fetched string alone —
 * both conventions look like valid proj4 syntax. If re-running this script
 * changes the towgs84 rotation signs (or presence) for a CRS with an existing
 * fixture in packages/data/scripts/fixtures/epsg-control-points.json, treat
 * that as a signal to re-verify against the EPSG Registry API's CoordOperation
 * method field before accepting the regenerated value, not just diff-review it.
 */
async function fetchProj4Definitions(entries: EpsgIndexEntry[], concurrency: number): Promise<void> {
  const queue = [...entries];
  let resolved = 0;
  let failed = 0;

  async function fetchProj4WithRetry(code: string, attempts = 3): Promise<string | null> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(`https://epsg.io/${code}.proj4`, {
          headers: { 'User-Agent': 'ifc-lite-epsg-generator/1.0' },
        });
        if (!response.ok) return null;
        const text = (await response.text()).trim();
        // Validate: proj4 strings start with +proj= or +title=
        if (!text || text.startsWith('<') || text.startsWith('{') || !text.includes('+')) {
          return null;
        }
        return text;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await new Promise(resolve => setTimeout(resolve, 200 * attempt));
        }
      }
    }
    return null;
  }

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (!entry) return;
      const proj4Def = await fetchProj4WithRetry(entry.code);
      if (proj4Def) {
        entry.proj4 = proj4Def;
        resolved++;
      } else {
        failed++;
      }
      const total = resolved + failed;
      if (total % 500 === 0) {
        console.log(`  proj4: ${total}/${entries.length} (${resolved} resolved, ${failed} missing)`);
      }
    }
  }

  console.log(`Fetching proj4 definitions from epsg.io for ${entries.length} entries...`);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`proj4 fetch complete: ${resolved} resolved, ${failed} missing out of ${entries.length}`);
}

function renderModule(entries: EpsgIndexEntry[]): string {
  const json = JSON.stringify(entries);
  const stringLiteral = JSON.stringify(json);

  return `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AUTO-GENERATED by \`scripts/generate-epsg-index.ts\`.
 *
 * Source: EPSG Registry API (${API_BASE_URL})
 * Dataset version: ${EPSG_DATASET_VERSION}
 * Terms: https://epsg.org/terms-of-use.html
 *
 * Do not edit by hand. Re-run \`pnpm generate:epsg-index\` to refresh.
 */

import type { EpsgIndexEntry } from '../epsg-types.js';

export const EPSG_INDEX_DATASET_VERSION = '${EPSG_DATASET_VERSION}';

const EPSG_INDEX_JSON = ${stringLiteral};

export const EPSG_INDEX: readonly EpsgIndexEntry[] = JSON.parse(EPSG_INDEX_JSON) as EpsgIndexEntry[];
`;
}

function printSummary(entries: EpsgIndexEntry[], elapsedMs: number, outPath: string): void {
  const json = JSON.stringify(entries);
  console.log(`Generated ${entries.length} EPSG CRS entries in ${elapsedMs}ms`);
  console.log(`JSON size: ${Buffer.byteLength(json)} bytes`);
  console.log(`Gzip size: ${gzipSync(json).byteLength} bytes`);
  console.log(`Output: ${outPath}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const summaries = await fetchAllSummaries(options.pageSize);
  const selected = options.limit == null ? summaries : summaries.slice(0, options.limit);
  const entries = await fetchEntries(selected, options.concurrency);
  await fetchProj4Definitions(entries, options.concurrency);
  const moduleSource = renderModule(entries);

  if (options.stdout) {
    process.stdout.write(moduleSource);
    return;
  }

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, `${moduleSource}\n`, 'utf8');
  printSummary(entries, Date.now() - startedAt, options.out);
}

await main();
