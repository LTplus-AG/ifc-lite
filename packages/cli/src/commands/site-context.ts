/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite site-context [model.ifc] --radius M --layers terrain,parcel,buildings --out context.glb
 *
 * Real terrain, the cadastral parcel and neighbouring buildings around a georeferenced Swiss model,
 * as one GLB in a local frame stated in EPSG:2056 / EPSG:5728, plus a JSON
 * summary. Network on by default (rate-limited, cached on disk).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSwissGeodata, type FetchLike } from '@ifc-lite/geodata-ch';
import {
  buildSiteContext,
  encodeSiteContextGlb,
  SiteContextCoverageError,
  summarizeSiteContext,
  swisstopoOnlyFetch,
  type BuildingsReader,
  type MapPoint,
  type SiteContextGeodata,
  type SiteContextLayerKind,
} from '@ifc-lite/site-context';
import { loadIfcFile } from '../loader.js';
import { fatal, printJson } from '../output.js';
import { defaultCacheDir, diskCache, offlineFetch, offlineTilesFetch, tilesDiskCache } from './site-context-cache.js';
import { modelFootprint, type ModelFootprint } from './site-context-footprint.js';
import { SiteContextModelError, siteCentreFromModel, type ModelCentre } from './site-context-model.js';

export const SITE_CONTEXT_HELP = `
  ifc-lite site-context — terrain, parcel and neighbouring buildings around a Swiss site as one GLB (EPSG:2056 / LN02)

  Usage:
    ifc-lite site-context <model.ifc> --out context.glb [options]
    ifc-lite site-context --centre E,N --out context.glb [options]
    ifc-lite site-context --egrid CH... --out context.glb [options]

  The centre comes from the model's IfcMapConversion (Eastings/Northings), which must be
  in EPSG:2056 ("CH1903+ / LV95" and other names that resolve to it are accepted). Another
  CRS @ifc-lite/geo can transform (e.g. LV03) has only its centre point reprojected. The
  model's rotation and scale are never applied: the context is placed against the model by
  the viewer. A stated vertical datum other than LN02 is refused. A model without a
  map conversion is refused; pass --centre E,N instead, or add the map conversion first.

  Options:
    --radius M          Half the side of the square site in metres (default 150, max 5000)
    --layers L,...      Any of terrain,parcel,buildings (default terrain,parcel)
    --subject-egid N    The model's own building in the buildings layer, by its EGID
    --tile-requests N   Request budget of the buildings tile read (default 64; cache hits are free)
    --resolution R|auto Terrain node spacing in metres (default auto: max(0.5, 2·radius/500))
    --out F             The GLB to write (required)
    --json              Print the summary as JSON
    --cache-dir D       Response cache (default ${'$'}XDG_CACHE_HOME/ifc-lite/geodata)
    --offline           Use only the cache directory; no network requests
    --rate R            Requests per second per host (default 5)

  Buildings: whole swissBUILDINGS3D buildings whose footprint touches the site square, each with a
  roof and a wall part. With a model, the building it stands in is marked "subject" (by
  --subject-egid, else by overlap with the plan rectangle spanned by the model's element placements);
  it is kept, not removed.

  Data: swissALTI3D and swissBUILDINGS3D (© swisstopo) and the cantonal cadastral web map
  (© Cadastral surveying and the cantons; terms unverified: check the canton's terms before
  redistributing). Show the attribution printed for each layer wherever the context is shown.
`;

const DEFAULT_RADIUS = 150;
const VALUE_FLAGS = new Set(['--radius', '--layers', '--resolution', '--out', '--centre', '--egrid', '--cache-dir', '--rate', '--subject-egid', '--tile-requests']);
const BOOL_FLAGS = new Set(['--json', '--offline']);

export class SiteContextUsageError extends Error {}

interface Parsed {
  positionals: string[];
  values: Map<string, string>;
  booleans: Set<string>;
}

function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = { positionals: [], values: new Map(), booleans: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new SiteContextUsageError(`${a} needs a value`);
      parsed.values.set(a, v);
    } else if (BOOL_FLAGS.has(a)) parsed.booleans.add(a);
    else if (a.startsWith('--')) throw new SiteContextUsageError(`unknown option ${a}; see \`ifc-lite site-context --help\``);
    else parsed.positionals.push(a);
  }
  return parsed;
}

function number(flag: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) throw new SiteContextUsageError(`${flag} must be a positive number, got "${raw}"`);
  return v;
}

function parseLayers(raw: string | undefined): SiteContextLayerKind[] {
  const layers = (raw ?? 'terrain,parcel').split(',').map((s) => s.trim()).filter(Boolean);
  for (const l of layers) {
    if (l !== 'terrain' && l !== 'parcel' && l !== 'buildings') throw new SiteContextUsageError(`unknown layer "${l}"; expected terrain, parcel or buildings`);
  }
  return layers as SiteContextLayerKind[];
}

function parseCentre(raw: string): { x: number; y: number } {
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || !parts.every(Number.isFinite)) throw new SiteContextUsageError(`--centre takes E,N in EPSG:2056, got "${raw}"`);
  return { x: parts[0], y: parts[1] };
}

export interface SiteContextDeps {
  /** Injected for tests; default: the Swiss geodata client with the disk cache. */
  geodata?: SiteContextGeodata;
  /** Injected for tests; default: the swisstopo 3D Tiles reader with the disk cache. */
  buildingsReader?: BuildingsReader;
  /**
   * The network fetch underneath, injected for tests; default `globalThis.fetch`. It is
   * always wrapped in the swisstopo host allowlist (no other host, no redirects).
   */
  fetch?: FetchLike;
  /** The geodata client's retry backoff, injected for tests; default a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function siteContextCommand(args: string[], deps: SiteContextDeps = {}): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(SITE_CONTEXT_HELP + '\n');
    return;
  }
  try {
    await run(args, deps);
  } catch (err) {
    if (err instanceof SiteContextUsageError || err instanceof SiteContextModelError || err instanceof SiteContextCoverageError) fatal(err.message);
    if (err instanceof RangeError) fatal(err.message);
    throw err;
  }
}

async function run(args: string[], deps: SiteContextDeps): Promise<void> {
  const p = parseArgs(args);
  const out = p.values.get('--out');
  if (!out) throw new SiteContextUsageError('site-context writes a GLB: pass --out context.glb');
  if (p.positionals.length > 1) throw new SiteContextUsageError('site-context takes at most one model file');
  const file = p.positionals[0];
  const centreArg = p.values.get('--centre');
  const egrid = p.values.get('--egrid')?.trim().toUpperCase();
  if ([file, centreArg, egrid].filter(Boolean).length !== 1) {
    throw new SiteContextUsageError('give exactly one of: a model file, --centre E,N, or --egrid CH...');
  }
  const radius = number('--radius', p.values.get('--radius'), DEFAULT_RADIUS);
  const rawRes = p.values.get('--resolution');
  const resolution = rawRes === undefined || rawRes === 'auto' ? 'auto' : number('--resolution', rawRes, 0);
  const layers = parseLayers(p.values.get('--layers'));
  const offline = p.booleans.has('--offline');
  const cacheDir = p.values.get('--cache-dir') ?? defaultCacheDir();
  const cache = diskCache(cacheDir);
  // Every request goes through the swisstopo allowlist: no CLI argument names a URL, and a
  // URL from a response (a STAC asset, a tileset's content URI, a redirect) cannot leave it.
  const network = swisstopoOnlyFetch(deps.fetch);
  const geodata = deps.geodata ?? createSwissGeodata({
    cache,
    requestsPerSecond: number('--rate', p.values.get('--rate'), 5),
    ...(offline ? { fetch: offlineFetch, maxRetries: 0 } : { fetch: network }),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  const requestsBefore = geodata.requestCount ?? 0;
  const started = Date.now();
  const tilesCache = tilesDiskCache(join(cacheDir, 'tiles3d'));
  const subjectEgid = p.values.get('--subject-egid')?.trim();
  if (subjectEgid !== undefined && !/^\d+$/.test(subjectEgid)) throw new SiteContextUsageError(`--subject-egid takes a numeric EGID, got "${subjectEgid}"`);
  const tileRequests = p.values.has('--tile-requests') ? number('--tile-requests', p.values.get('--tile-requests'), 64) : undefined;

  let model: ModelCentre | null = null;
  let centre: { x: number; y: number };
  let centreSource: 'model' | '--centre' | '--egrid';
  let footprint: ModelFootprint | null = null;
  if (file) {
    const store = await loadIfcFile(file);
    model = await siteCentreFromModel(store);
    centre = model.centre;
    centreSource = 'model';
    if (layers.includes('buildings')) {
      footprint = await modelFootprint(new Uint8Array(await readFile(file)), model, store.lengthUnitScale ?? 1);
      if (!footprint) model.warnings.push('the model gives no footprint (no placed element, or a corner that could not be converted) to find its own building by');
      else model.warnings.push(...footprint.warnings);
    }
  } else if (centreArg) {
    centre = parseCentre(centreArg);
    centreSource = '--centre';
  } else {
    const parcel = await geodata.parcelById(egrid!);
    if (!parcel) throw new SiteContextUsageError(`no parcel with EGRID ${egrid}`);
    const ring = parcel.geometry.type === 'Polygon' ? parcel.geometry.coordinates[0] : parcel.geometry.coordinates[0][0];
    const xs = ring.map((q) => q[0]);
    const ys = ring.map((q) => q[1]);
    centre = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    centreSource = '--egrid';
  }

  const doc = await buildSiteContext({
    centre,
    radius,
    layers,
    resolution,
    subject: subjectOf(egrid, subjectEgid, footprint?.ring),
    geodata,
    buildings: {
      reader: deps.buildingsReader,
      cache: tilesCache,
      fetch: offline ? offlineTilesFetch : network,
      maxRequests: tileRequests,
    },
    onProgress: p.booleans.has('--json') ? undefined : (e) => process.stderr.write(`  ${e.message}\n`),
  });
  const glb = encodeSiteContextGlb(doc);
  await writeFile(out, glb);
  const summary = summarizeSiteContext(doc);
  const terrainProv = doc.layers.find((l) => l.kind === 'terrain')?.features[0]?.provenance;
  const report = {
    ...(file ? { file } : {}),
    output: out,
    bytes: glb.byteLength,
    centre: { ...centre, source: centreSource },
    radius,
    resolution: terrainProv?.resolution ?? resolution,
    ...(model ? { model: { crs: model.crs, mapUnitToMetres: model.mapUnitToMetres, mapUnitSource: model.mapUnitSource, verticalDatum: model.verticalDatum, rotationDegrees: model.rotationDegrees, rotationApplied: false } } : {}),
    crs: summary.crs,
    verticalCrs: summary.verticalCrs,
    origin: summary.origin,
    originHeight: summary.originHeight ?? null,
    requests: (geodata.requestCount ?? 0) - requestsBefore + (summary.buildings?.requests ?? 0),
    cache: { dir: cacheDir, hits: cache.hits + tilesCache.hits, writes: cache.writes + tilesCache.writes, offline },
    seconds: Math.round((Date.now() - started) / 100) / 10,
    layers: summary.layers.map(({ attribution, ...l }) => ({ ...l, attribution: attribution.map((a) => a.text) })),
    parcels: summary.parcels,
    ...(summary.buildings
      ? {
          buildings: {
            ...summary.buildings,
            subjectFootprint: footprint
              ? {
                  source: 'plan bounding rectangle of the model element placements (LOD0 boxes), map conversion applied',
                  elements: footprint.elements,
                  shapedElements: footprint.shapedElements,
                  ring: footprint.ring,
                }
              : null,
            issues: summary.layers.find((l) => l.kind === 'buildings')!.issues,
          },
        }
      : {}),
    attribution: [...new Set(summary.layers.flatMap((l) => l.attribution.map((a) => a.text)))],
    warnings: model?.warnings ?? [],
  };
  if (p.booleans.has('--json')) {
    printJson(report);
    return;
  }
  const lines = [
    `site-context: wrote ${out} (${glb.byteLength} bytes, ${report.requests} requests)`,
    `  origin ${doc.origin.join(', ')}  (EPSG:2056 / EPSG:5728, x east, y north, z up)`,
    ...(doc.originHeight?.terrainHeight === null ? [`  H0 is 0 as a frame offset, not a terrain height: ${doc.originHeight.reason ?? 'no terrain height'}`] : []),
    ...(model ? [`  centre from the model: ${model.crs.name} (${model.crs.matched}); its rotation is not applied`] : []),
    ...report.layers.map((l) => `  ${l.kind}: ${l.features} features, ${l.triangles} triangles${l.complete ? '' : ' (INCOMPLETE)'}`),
    ...summary.parcels.map((q) => `  parcel ${q.number ?? '?'} ${q.egrid}${q.oerebExtractUrl ? `  ÖREB ${q.oerebExtractUrl}` : ''}`),
    ...(summary.buildings
      ? [
          `  buildings: ${summary.buildings.count} (${summary.buildings.withEgid} with EGID), ${summary.buildings.requests ?? 0} tile requests, ${summary.buildings.bytes ?? 0} bytes` +
            `; subject ${summary.buildings.subject ? summary.buildings.subject.ids.join(', ') : 'not marked'}`,
        ]
      : []),
    ...report.warnings.map((w) => `  warning: ${w}`),
    ...summary.layers.flatMap((l) => l.issues.map((i) => `  ${l.kind} ${i.severity}: ${i.message}`)),
    `  attribution: ${report.attribution.join('; ')}`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

function subjectOf(egrid: string | undefined, egid: string | undefined, ring: MapPoint[] | undefined) {
  if (!egrid && !egid && !ring) return undefined;
  return { ...(egrid ? { egrid } : {}), ...(egid ? { egid } : {}), ...(ring ? { footprint: [ring] } : {}) };
}
