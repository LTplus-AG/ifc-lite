#!/usr/bin/env tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate the committed EPSG extents sidecar (area of use, native unit,
 * compound components) for every code in the bundled EPSG index.
 *
 * Source: EPSG Registry API (https://apps.epsg.org/api/v1), the same source and
 * terms as `generate-epsg-index.ts`. The index file itself is not rewritten,
 * so its proj4 strings and names stay exactly as shipped.
 *
 * Safety: the script exits non-zero and writes nothing if any code of the index
 * lacks a row, unless it is listed in `scripts/epsg-extents-allowlist.json`
 * (`{ "<code>": "<reason>" }`, committed). The file is written through a temp
 * file and renamed. `--limit=N` needs `--out=PATH` or `--stdout`, so a partial
 * run can never overwrite the committed file. Works from any directory.
 *
 * Usage:
 *   npx tsx scripts/generate-epsg-extents.ts
 *   npx tsx scripts/generate-epsg-extents.ts --limit=200 --stdout
 *   npx tsx scripts/generate-epsg-extents.ts --limit=200 --out=/tmp/x.ts
 *   Options: --concurrency=N (1..8, default 6), --delay-ms=N (default 50)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// EPSG_API_BASE and EPSG_EXTENTS_ALLOWLIST exist so the tests can point the script at a local fake registry.
const API = process.env.EPSG_API_BASE ?? 'https://apps.epsg.org/api/v1';
const TERMS_URL = 'https://epsg.org/terms-of-use.html';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = path.join(REPO_ROOT, 'packages/data/src/generated/epsg-index.generated.ts');
const DEFAULT_OUT = path.join(REPO_ROOT, 'packages/data/src/generated/epsg-extents.generated.ts');
const ALLOWLIST_PATH = process.env.EPSG_EXTENTS_ALLOWLIST ?? path.join(REPO_ROOT, 'scripts/epsg-extents-allowlist.json');

type Ref = { Code?: number; Name?: string };
type Detail = {
  Kind?: string;
  Usage?: Array<{ Extent?: Ref; Deprecation?: unknown }>;
  CoordSys?: Ref;
  HorizontalCrs?: Ref;
  VerticalCrs?: Ref;
};

const args = process.argv.slice(2);
const opt = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
/** A numeric option must be a whole number in range; NaN or junk would silently start no workers or skip the politeness delay. */
function intOpt(name: string, fallback: number, min: number, max: number): number {
  const raw = opt(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(n) || n < min || n > max) {
    console.error(`--${name} must be an integer from ${min} to ${max}, got "${raw}". Nothing written.`);
    process.exit(2);
  }
  return n;
}
const concurrency = intOpt('concurrency', 6, 1, 8);
const delayMs = intOpt('delay-ms', 50, 0, 60_000);
const limit = opt('limit') !== undefined ? intOpt('limit', 0, 1, Number.MAX_SAFE_INTEGER) : null;
const stdout = args.includes('--stdout');
const out = opt('out') ? path.resolve(opt('out')!) : DEFAULT_OUT;
if (limit !== null && !stdout && (!opt('out') || out === path.resolve(DEFAULT_OUT))) {
  console.error('--limit writes a partial file: pass --out=PATH (not the committed file) or --stdout so the committed file is not overwritten.');
  process.exit(2);
}

async function getJson<T>(url: string, attempts = 4): Promise<T | null> {
  let last: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'ifc-lite-epsg-generator/1.0' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
      await new Promise(r => setTimeout(r, 300 * i));
    }
  }
  throw new Error(`${url}: ${String(last)}`);
}

async function pool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  }));
}

/** The registry API has no version endpoint; the site header shows `EPSG Dataset : vNN.NNN`. */
async function readDatasetVersion(): Promise<string> {
  const override = opt('dataset-version');
  if (override) return override;
  const res = await fetch(TERMS_URL, { headers: { 'User-Agent': 'ifc-lite-epsg-generator/1.0' } });
  if (!res.ok) throw new Error(`${TERMS_URL}: HTTP ${res.status}`);
  const m = /EPSG Dataset\s*:\s*<\/dt>\s*<dd>\s*v(\d+\.\d+)/.exec(await res.text());
  if (!m) throw new Error(`cannot read the EPSG dataset version from ${TERMS_URL}; pass --dataset-version=NN.NNN`);
  return m[1];
}

function readIndex(): Array<{ code: string; kind: string }> {
  const content = fs.readFileSync(INDEX_PATH, 'utf8');
  const m = content.match(/EPSG_INDEX_JSON = (".*")/s);
  if (!m) throw new Error('cannot parse EPSG_INDEX_JSON');
  return JSON.parse(JSON.parse(m[1]) as string);
}

const round = (n: number, places = 6) => Math.round(n * 10 ** places) / 10 ** places;

async function main(): Promise<void> {
  const index = readIndex();
  const selected = limit ? index.slice(0, limit) : index;
  const allowlist: Record<string, string> = fs.existsSync(ALLOWLIST_PATH)
    ? JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'))
    : {};
  for (const [code, reason] of Object.entries(allowlist)) {
    if (typeof reason !== 'string' || reason.trim() === '') throw new Error(`allow-list entry ${code} needs a reason`);
  }
  const datasetVersion = await readDatasetVersion();

  const details = new Map<string, Detail>();
  const missing: string[] = [];
  await pool(selected, async entry => {
    const base = entry.kind === 'Compound' ? 'CompoundCoordRefSystem' : 'CoordRefSystem';
    const d = await getJson<Detail>(`${API}/${base}/${entry.code}`);
    if (d) details.set(entry.code, d);
    else if (!allowlist[entry.code]) missing.push(entry.code);
    else console.warn(`EPSG:${entry.code}: not served by the registry (allow-listed: ${allowlist[entry.code]})`);
  });
  if (missing.length) {
    console.error(`${missing.length} index code(s) not served by the registry and not allow-listed in ${path.relative(REPO_ROOT, ALLOWLIST_PATH)}: ${missing.slice(0, 20).join(', ')}`);
    console.error('Nothing written.');
    process.exit(1);
  }

  const extentCodes = new Set<number>();
  const coordSysCodes = new Set<number>();
  for (const d of details.values()) {
    for (const u of d.Usage ?? []) if (u.Extent?.Code != null) extentCodes.add(u.Extent.Code);
    if (d.CoordSys?.Code != null) coordSysCodes.add(d.CoordSys.Code);
  }

  const extents = new Map<number, [number, number, number, number]>();
  await pool([...extentCodes], async code => {
    const e = await getJson<Record<string, number | null>>(`${API}/Extent/${code}`);
    if (!e) throw new Error(`Extent ${code} is referenced by a usage but not served`);
    const w = e.BoundingBoxWestBoundLongitude, s = e.BoundingBoxSouthBoundLatitude;
    const ea = e.BoundingBoxEastBoundLongitude, n = e.BoundingBoxNorthBoundLatitude;
    if ([w, s, ea, n].every(v => typeof v === 'number')) extents.set(code, [round(w!), round(s!), round(ea!), round(n!)]);
  });

  // CoordSystem -> first axis unit; Unit -> name and factor to its target unit.
  const unitOfSys = new Map<number, number>();
  await pool([...coordSysCodes], async code => {
    const cs = await getJson<{ Axis?: Array<{ Unit?: Ref }> }>(`${API}/CoordSystem/${code}`);
    const unit = cs?.Axis?.[0]?.Unit?.Code;
    if (unit != null) unitOfSys.set(code, unit);
  });
  const units = new Map<number, { name: string; metres: number | null }>();
  await pool([...new Set(unitOfSys.values())], async code => {
    const u = await getJson<{ Name: string; Type?: string; FactorB?: number; FactorC?: number; TargetUnit?: Ref }>(`${API}/Unit/${code}`);
    if (!u) return;
    const isLength = u.Type === 'length' && u.TargetUnit?.Code === 9001;
    units.set(code, { name: u.Name.replace(/ \(supplier to define representation\)$/, ''), metres: isLength && u.FactorB && u.FactorC ? round(u.FactorB / u.FactorC, 10) : null });
  });

  // Compact tables: shared extent boxes and units, one short row per code.
  const unitList: Array<[string, number | null]> = [];
  const unitIdx = new Map<number, number>();
  const boxList: Array<[number, number, number, number]> = [];
  const boxIdx = new Map<string, number>();
  const rows: Record<string, unknown[]> = {};

  for (const entry of selected) {
    const d = details.get(entry.code);
    if (!d) continue;
    const boxes: number[] = [];
    for (const u of d.Usage ?? []) {
      if (u.Deprecation) continue; // a retired usage is not an area the CRS is valid in
      const box = u.Extent?.Code != null ? extents.get(u.Extent.Code) : undefined;
      if (!box) continue;
      const key = box.join(',');
      if (!boxIdx.has(key)) { boxIdx.set(key, boxList.length); boxList.push(box); }
      const i = boxIdx.get(key)!;
      if (!boxes.includes(i)) boxes.push(i);
    }
    const sys = d.CoordSys?.Code != null ? unitOfSys.get(d.CoordSys.Code) : undefined;
    let u = -1;
    if (sys != null && units.has(sys)) {
      if (!unitIdx.has(sys)) { unitIdx.set(sys, unitList.length); const x = units.get(sys)!; unitList.push([x.name, x.metres]); }
      u = unitIdx.get(sys)!;
    }
    const h = d.HorizontalCrs?.Code, v = d.VerticalCrs?.Code;
    // [unit index (-1 none), box indexes, horizontal code, vertical code]; trailing nulls dropped.
    const row: unknown[] = [u, boxes, h ?? null, v ?? null];
    while (row.length > 2 && row[row.length - 1] === null) row.pop();
    rows[entry.code] = row;
  }

  // A compound CRS has no axis system of its own: its native horizontal unit is its horizontal component's.
  for (const entry of selected) {
    const row = rows[entry.code];
    const h = row?.[2];
    if (row && row[0] === -1 && typeof h === 'number' && rows[String(h)]) row[0] = rows[String(h)][0];
  }
  const missingUnit = Object.entries(rows).filter(([, r]) => r[0] === -1).map(([c]) => c);
  // stderr: with --stdout the generated module owns stdout.
  console.error(`rows without a unit: ${missingUnit.length}`, missingUnit.slice(0, 12).join(','));

  const body = JSON.stringify({ units: unitList, boxes: boxList, rows });
  const fetched = new Date().toISOString().slice(0, 10);
  const source = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AUTO-GENERATED by \`scripts/generate-epsg-extents.ts\`.
 *
 * Source: EPSG Registry API (https://apps.epsg.org/api/v1), fetched ${fetched}.
 * EPSG Dataset version: ${datasetVersion}. Note: the main index
 * (epsg-index.generated.ts) is dataset 12.054, so a few names and extents may
 * differ between the two files; only the code list is taken from the index.
 *
 * Ownership: the EPSG Dataset is owned by the International Association of Oil
 * & Gas Producers (IOGP). It is compiled by the Geodetic Subcommittee of the
 * IOGP from publicly available and member-supplied information.
 * Terms of use: ${TERMS_URL} (Revised 8 April 2016). Recipients of this file
 * must be informed of those terms. The data is provided "AS IS" under them,
 * without warranty of any kind; neither the IOGP nor its members accept
 * liability for its use. Under the terms the data may be included in a
 * commercial package provided that any commerciality is based on value added
 * by the provider and not on a value ascribed to the EPSG Dataset, and data
 * modified other than as the terms permit must not be attributed to the EPSG
 * Dataset.
 *
 * Derived subset. This file is NOT the EPSG Dataset; it is a reduced,
 * re-encoded extract. It applies exactly these transformations to registry data:
 *  1. Only the codes of epsg-index.generated.ts are kept, and only these
 *     fields: area-of-use bounding boxes, the native axis unit, and the
 *     horizontal/vertical component codes of compound CRSs. No CRS definition,
 *     datum, projection or parameter is included.
 *  2. Usages marked deprecated in the registry are dropped; every current
 *     usage's extent is kept, in registry order, identical boxes stored once.
 *  3. Bounding-box values are rounded to 6 decimal places.
 *  4. A unit's metres-per-unit is FactorB / FactorC rounded to 10 decimal
 *     places, and only for length units whose target unit is the metre (9001);
 *     angular and other units carry no factor. The unit is the first axis of
 *     the CRS's coordinate system; the suffix " (supplier to define
 *     representation)" is removed from unit names.
 *  5. A compound CRS has no axis system of its own, so it takes its horizontal
 *     component's unit.
 *  6. Rows are JSON arrays in shared tables (units, boxes) rather than the
 *     registry's own structure.
 *
 * Do not edit by hand. Re-run \`pnpm generate:epsg-extents\` to refresh.
 */

export const EPSG_EXTENTS_FETCHED = '${fetched}';

/** EPSG Dataset version of this file's data (the main index is EPSG_INDEX_DATASET_VERSION). */
export const EPSG_EXTENTS_DATASET_VERSION = '${datasetVersion}';

/** units: [name, metres per unit | null for non-length]; boxes: [west, south, east, north] degrees. */
export const EPSG_EXTENTS_JSON = ${JSON.stringify(body)};
`;

  if (stdout) { process.stdout.write(source); return; }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, source, 'utf8');
  fs.renameSync(tmp, out);
  console.log(`${Object.keys(rows).length} rows, ${boxList.length} boxes, ${unitList.length} units`);
  console.log(`bytes ${Buffer.byteLength(source)}, gzip ${gzipSync(source).byteLength}`);
}

await main();
