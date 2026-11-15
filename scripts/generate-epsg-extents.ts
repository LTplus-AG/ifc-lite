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
 * Usage:
 *   npx tsx scripts/generate-epsg-extents.ts
 *   npx tsx scripts/generate-epsg-extents.ts --limit=200 --stdout
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

const API = 'https://apps.epsg.org/api/v1';
const INDEX_PATH = path.resolve('packages/data/src/generated/epsg-index.generated.ts');
const DEFAULT_OUT = path.resolve('packages/data/src/generated/epsg-extents.generated.ts');

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
const concurrency = Number(opt('concurrency') ?? 20);
const limit = opt('limit') ? Number(opt('limit')) : null;
const out = opt('out') ? path.resolve(opt('out')!) : DEFAULT_OUT;

async function getJson<T>(url: string, attempts = 4): Promise<T | null> {
  let last: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
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

  const details = new Map<string, Detail>();
  await pool(selected, async entry => {
    const base = entry.kind === 'Compound' ? 'CompoundCoordRefSystem' : 'CoordRefSystem';
    let d = await getJson<Detail>(`${API}/${base}/${entry.code}`);
    if (!d) console.warn(`EPSG:${entry.code}: not served by the registry`);
    else details.set(entry.code, d);
  });

  const extentCodes = new Set<number>();
  const coordSysCodes = new Set<number>();
  for (const d of details.values()) {
    for (const u of d.Usage ?? []) if (u.Extent?.Code != null) extentCodes.add(u.Extent.Code);
    if (d.CoordSys?.Code != null) coordSysCodes.add(d.CoordSys.Code);
  }

  const extents = new Map<number, [number, number, number, number]>();
  await pool([...extentCodes], async code => {
    const e = await getJson<Record<string, number | null>>(`${API}/Extent/${code}`);
    if (!e) return;
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
  console.log(`rows without a unit: ${missingUnit.length}`, missingUnit.slice(0, 12).join(','));

  const body = JSON.stringify({ units: unitList, boxes: boxList, rows });
  const fetched = new Date().toISOString().slice(0, 10);
  const source = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AUTO-GENERATED by \`scripts/generate-epsg-extents.ts\`.
 *
 * Source: EPSG Registry API (${API}), fetched ${fetched}.
 * Content: area-of-use bounding boxes, native axis unit (name and metres per
 * unit), and horizontal/vertical components of compound CRSs, for the codes in
 * epsg-index.generated.ts.
 * Terms: https://epsg.org/terms-of-use.html (EPSG Dataset, IOGP)
 *
 * Do not edit by hand. Re-run \`pnpm generate:epsg-extents\` to refresh.
 */

export const EPSG_EXTENTS_FETCHED = '${fetched}';

/** units: [name, metres per unit | null for non-length]; boxes: [west, south, east, north] degrees. */
export const EPSG_EXTENTS_JSON = ${JSON.stringify(body)};
`;

  if (args.includes('--stdout')) { process.stdout.write(source); return; }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, source, 'utf8');
  console.log(`${Object.keys(rows).length} rows, ${boxList.length} boxes, ${unitList.length} units`);
  console.log(`bytes ${Buffer.byteLength(source)}, gzip ${gzipSync(source).byteLength}`);
}

await main();
