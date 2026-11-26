// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `ifc-lite extract-entities <file.ifc> [selectors] --out sub.ifc [--view]`
 *
 * Pull a handful of entities out of a large IFC into a small, VALID, viewable
 * standalone model — the isolate step of a "reproduce a suspect element" loop.
 * Selectors (unioned):
 *   --product <GUID|expressId>  explicit product(s); repeatable or comma-list
 *   --type <IfcType>            every product of a type
 *   --storey <GUID|name|id>     the storey and its elements (spatial ownership; placement chain for unowned ones)
 *   --detect [--top N]          the N meshes a geometry-triage pass ranks most unusual
 *
 * The output carries each selected product's full forward reference closure PLUS
 * the shared context roots (IfcProject, unit assignment, geometric contexts, and
 * the backward closure of the selection's spatial ancestors — only the
 * site/building/storey/space chain actually reached by what was selected, not
 * every spatial-structure instance in the model, see `@ifc-lite/export` step-subset-spatial-ancestors.ts) and
 * every spatial-structure relation, its related-objects SET rewritten down to
 * the kept members (see `@ifc-lite/export` step-subset-relations.ts), so the result parses and
 * renders on its own.
 *
 * `--detect --report [--json]` prints the triage report WITHOUT extracting. The
 * report separates HARD defects (non-finite or |coord|>1e4 vertices after the
 * per-element local-frame/RTC recentre — genuine corruption) from REVIEW
 * heuristics (oversized AABB, needle/burst triangulation) that are frequently
 * legitimate for thin or large elements and must be eyeballed, not trusted.
 */
import { constants as bufferConstants } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { buildSubset, parseStep, selectSubsetSeeds, serializeSubset } from '@ifc-lite/export';
import { detectSchemaVersion, parseSourceHeader } from '@ifc-lite/parser';
import { fatal, getFlag, getAllFlags, hasFlag, routeConsoleDiagnosticsToStderr } from '../output.js';
import { logger } from '../logger.js';
import { readModelInput } from '../model-input.js';

// ── Geometry triage ─────────────────────────────────────────────────────────

interface TriageRow {
  expressId: number;
  ifcType: string;
  tris: number;
  /** Non-finite vertices (NaN/Inf) — a HARD defect. */
  nonFinite: number;
  /** Vertices with |coord|>1e4 after recentre — HARD (RTC/local-frame miss). */
  huge: number;
  /** full-AABB / 2-98 percentile-AABB diagonal ratio — REVIEW heuristic. */
  aabbBlowout: number;
}

/**
 * Score meshes for triage. Pure so it is unit-testable without a wasm round-trip.
 * A HARD defect (non-finite/huge) always sorts above any REVIEW heuristic.
 */
export function scoreTriage(row: TriageRow): number {
  if (row.nonFinite > 0) return 1e12 + row.nonFinite;
  if (row.huge > 0) return 1e11 + row.huge;
  return row.aabbBlowout;
}

function pct(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

async function triage(bytes: Uint8Array): Promise<TriageRow[]> {
  const { GeometryProcessor } = await import('@ifc-lite/geometry');
  const gp = new GeometryProcessor();
  let res: Awaited<ReturnType<typeof gp.process>>;
  try {
    await gp.init();
    res = await gp.process(bytes);
  } finally {
    gp.dispose();
  }
  const rows: TriageRow[] = [];
  for (const m of res.meshes) {
    const p = m.positions;
    const nv = p.length / 3;
    if (nv === 0) continue;
    const xs = new Float64Array(nv);
    const ys = new Float64Array(nv);
    const zs = new Float64Array(nv);
    let nonFinite = 0;
    let huge = 0;
    for (let i = 0, k = 0; i < p.length; i += 3, k++) {
      const x = p[i];
      const y = p[i + 1];
      const z = p[i + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nonFinite++;
      if (Math.abs(x) > 1e4 || Math.abs(y) > 1e4 || Math.abs(z) > 1e4) huge++;
      xs[k] = x;
      ys[k] = y;
      zs[k] = z;
    }
    xs.sort();
    ys.sort();
    zs.sort();
    const full = Math.hypot(xs[nv - 1] - xs[0], ys[nv - 1] - ys[0], zs[nv - 1] - zs[0]);
    const trim = Math.hypot(pct(xs, 98) - pct(xs, 2), pct(ys, 98) - pct(ys, 2), pct(zs, 98) - pct(zs, 2));
    const aabbBlowout = trim > 0.01 ? full / trim : full > 0.01 ? 999 : 1;
    rows.push({
      expressId: m.expressId,
      ifcType: m.ifcType ?? '',
      tris: m.indices.length / 3,
      nonFinite,
      huge,
      aabbBlowout: +aabbBlowout.toFixed(2),
    });
  }
  rows.sort((a, b) => scoreTriage(b) - scoreTriage(a));
  return rows;
}

// ── Command ─────────────────────────────────────────────────────────────────

export async function extractEntitiesCommand(args: string[]): Promise<void> {
  // stdout carries this command's payload, so redirect console diagnostics
  // BEFORE the first parse/geometry init (see the function's own docstring).
  routeConsoleDiagnosticsToStderr();
  const filePath = args.find((a) => !a.startsWith('-') && !isFlagValue(args, a));
  if (!filePath) {
    fatal(
      'Usage: ifc-lite extract-entities <file.ifc> [--product ID|GUID] [--type T] ' +
        '[--storey ID|GUID|name] [--detect [--top N]] --out sub.ifc [--view] [--port N]\n' +
        '       ifc-lite extract-entities <file.ifc> --detect --report [--json]',
    );
    return;
  }

  const input = await readModelInput(filePath);
  const buf = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  if (buf.length >= bufferConstants.MAX_STRING_LENGTH) {
    fatal(
      `File is too large to extract from (${buf.length} bytes >= V8 string cap); ` +
        'split it first or file an issue if you hit this on a real model.',
    );
    return;
  }
  // latin1 is a lossless byte<->char bijection: STEP tokenization is ASCII-only,
  // and re-emitting `full` through latin1 round-trips raw high bytes (unescaped
  // umlauts in real-world exports) byte-identically where utf8 would mangle
  // them to U+FFFD.
  const text = buf.toString('latin1');
  const parsed = parseStep(text);
  logger.info(`Parsed ${parsed.instances.size} STEP instances from ${input.name}`);

  const detect = hasFlag(args, '--detect');
  const report = hasFlag(args, '--report');
  const asJson = hasFlag(args, '--json');
  // Fall back to 20 on a missing or non-numeric `--top` (a `NaN` would make
  // every `slice(0, topN)` return nothing).
  const topRaw = Number.parseInt(getFlag(args, '--top') ?? '20', 10);
  const topN = Number.isNaN(topRaw) ? 20 : topRaw;

  // ── Detect-only report path ──
  if (detect && report) {
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const rows = await triage(bytes);
    const hard = rows.filter((r) => r.nonFinite > 0 || r.huge > 0);
    if (asJson) {
      process.stdout.write(JSON.stringify({ total: rows.length, hardDefects: hard, top: rows.slice(0, topN) }, null, 2) + '\n');
      return;
    }
    process.stdout.write(`Geometry triage — ${rows.length} meshes\n\n`);
    process.stdout.write(
      hard.length > 0
        ? `HARD defects (non-finite or |coord|>1e4 vertices — genuine corruption): ${hard.length}\n`
        : `HARD defects: none (no NaN/Inf, no coordinate collapse)\n`,
    );
    for (const r of hard.slice(0, topN)) {
      process.stdout.write(`  #${r.expressId} ${r.ifcType} nonFinite=${r.nonFinite} huge=${r.huge}\n`);
    }
    process.stdout.write(
      `\nREVIEW heuristics (top ${topN} by AABB blowout — OFTEN LEGITIMATE for thin/large elements; eyeball, do not trust):\n`,
    );
    for (const r of rows.slice(0, topN)) {
      process.stdout.write(`  #${r.expressId} ${r.ifcType} tris=${r.tris} aabbBlowout=${r.aabbBlowout}x\n`);
    }
    return;
  }

  // ── Extraction path — collect seed products from all selectors ──
  const outPath = getFlag(args, '--out');
  const splitFlag = (flag: string) => getAllFlags(args, flag).flatMap((v) => v.split(','));
  const requestedTypes = splitFlag('--type').map((t) => t.trim()).filter(Boolean);
  const seeds = selectSubsetSeeds(parsed, {
    products: splitFlag('--product'),
    types: requestedTypes,
    storeys: splitFlag('--storey'),
    schemaVersion: detectSchemaVersion(buf, parseSourceHeader(buf)),
  });
  if (detect) {
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const rows = await triage(bytes);
    for (const r of rows.slice(0, topN)) seeds.add(r.expressId);
  }

  if (seeds.size === 0) {
    // Naming the selector that came back empty, rather than listing the flags
    // the caller just used: `--type IfcWall` on a model with no walls used to
    // answer "Use --product, --type, --storey, or --detect."
    fatal(
      requestedTypes.length > 0
        ? `No entities selected: nothing in this file matches --type ${requestedTypes.join(', ')} (or its subtypes).`
        : 'No entities selected. Use --product, --type, --storey, or --detect.'
    );
    return;
  }
  if (!outPath) {
    fatal('Missing --out <sub.ifc> for extraction (or use --detect --report for a report).');
    return;
  }

  const subset = buildSubset(seeds, parsed);
  const out = serializeSubset(subset, parsed);
  await writeFile(outPath, out, 'latin1');
  process.stdout.write(
    `Extracted ${seeds.size} product(s) → ${subset.keep.size} instances → ${outPath}\n`,
  );

  if (hasFlag(args, '--view')) {
    const { viewCommand } = await import('./view.js');
    const viewArgs = [outPath];
    const port = getFlag(args, '--port');
    if (port) viewArgs.push('--port', port);
    await viewCommand(viewArgs);
  }
}

/** True when `a` is the VALUE of a preceding option flag (so it isn't the file). */
function isFlagValue(args: string[], a: string): boolean {
  const idx = args.indexOf(a);
  return idx > 0 && args[idx - 1].startsWith('--') && args[idx - 1] !== '--detect' && args[idx - 1] !== '--report' && args[idx - 1] !== '--view' && args[idx - 1] !== '--json';
}
