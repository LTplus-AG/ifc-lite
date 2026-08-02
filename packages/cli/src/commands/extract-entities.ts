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
 *   --storey <GUID|name|id>     every product placed under a storey (placement chain)
 *   --detect [--top N]          the N meshes a geometry-triage pass ranks most unusual
 *
 * The output carries each selected product's full forward reference closure PLUS
 * the shared context roots (IfcProject, unit assignment, geometric contexts, the
 * spatial site/building/storey skeleton) and every spatial-containment relation
 * whose members are all kept — so the result parses and renders on its own.
 *
 * `--detect --report [--json]` prints the triage report WITHOUT extracting. The
 * report separates HARD defects (non-finite or |coord|>1e4 vertices after the
 * per-element local-frame/RTC recentre — genuine corruption) from REVIEW
 * heuristics (oversized AABB, needle/burst triangulation) that are frequently
 * legitimate for thin or large elements and must be eyeballed, not trusted.
 */
import { constants as bufferConstants } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fatal, getFlag, getAllFlags, hasFlag } from '../output.js';
import { logger } from '../logger.js';

/** One parsed STEP instance: `#id = TYPE(<body>);`. */
interface Instance {
  id: number;
  type: string;
  /** Argument text between the outermost parentheses (references + literals). */
  body: string;
  /** The verbatim `#id= TYPE(...);` text, re-emitted unchanged into the subset. */
  full: string;
}

interface ParsedStep {
  header: string;
  instances: Map<number, Instance>;
  /** 22-char GlobalId → expressId, for rooted entities. */
  guidToId: Map<string, number>;
}

/**
 * String-aware STEP DATA tokenizer. Splits the data section into instances at
 * the `;` that terminates each `#id = TYPE(...)`, ignoring `;`/`#`/`(` inside
 * STEP string literals (`'...'`, where `''` is an escaped quote). A regex split
 * mis-fires on names containing `;` or `#` (common in Revit exports), so this
 * scans character by character instead.
 */
export function parseStep(text: string): ParsedStep {
  const dataStart = text.indexOf('DATA;');
  if (dataStart < 0) throw new Error('Not a STEP file: no DATA; section');
  const headerEnd = text.indexOf('\n', dataStart) + 1;
  const header = text.slice(0, headerEnd);
  const data = text;

  const instances = new Map<number, Instance>();
  const guidToId = new Map<string, number>();

  let i = headerEnd;
  const n = data.length;
  while (i < n) {
    // Seek the next `#`
    while (i < n && data[i] !== '#') {
      // Stop at ENDSEC to avoid scanning the footer.
      if (data.startsWith('ENDSEC', i)) {
        i = n;
        break;
      }
      i++;
    }
    if (i >= n) break;
    const hashStart = i;
    i++; // past '#'
    let idStr = '';
    while (i < n && data[i] >= '0' && data[i] <= '9') idStr += data[i++];
    if (idStr === '') continue; // a `#` inside something odd; skip
    // expect optional spaces then '='
    let j = i;
    while (j < n && (data[j] === ' ' || data[j] === '\t')) j++;
    if (data[j] !== '=') continue; // `#42` as a REFERENCE, not a definition
    j++;
    while (j < n && (data[j] === ' ' || data[j] === '\t' || data[j] === '\n' || data[j] === '\r')) j++;
    // read TYPE
    let type = '';
    while (j < n && /[A-Za-z0-9_]/.test(data[j])) type += data[j++];
    // now consume the balanced `( ... )` respecting strings, then the ';'
    while (j < n && data[j] !== '(') j++;
    const bodyStart = j + 1;
    let depth = 0;
    let inStr = false;
    for (; j < n; j++) {
      const ch = data[j];
      if (inStr) {
        if (ch === "'") {
          if (data[j + 1] === "'") j++; // escaped quote
          else inStr = false;
        }
        continue;
      }
      if (ch === "'") inStr = true;
      else if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    const bodyEnd = j - 1; // index of the matching ')'
    // consume up to and including the terminating ';'
    while (j < n && data[j] !== ';') j++;
    const semi = j;
    const id = parseInt(idStr, 10);
    const body = data.slice(bodyStart, bodyEnd);
    const full = data.slice(hashStart, semi + 1).trim();
    instances.set(id, { id, type: type.toUpperCase(), body, full });
    // First quoted 22-char token is the GlobalId of a rooted entity.
    const gm = /^\s*'([^']{22})'/.exec(body);
    if (gm) guidToId.set(gm[1], id);
    i = semi + 1;
  }
  return { header, instances, guidToId };
}

/** Resolve one selector token to an expressId (`#42`, `42`, or a GlobalId).
 * An `#id` / bare id is validated against the model too, so a typo'd or stale
 * id fails loudly instead of silently selecting nothing. */
export function resolveToId(token: string, parsed: ParsedStep): number {
  const t = token.trim();
  if (t.startsWith('#') || /^\d+$/.test(t)) {
    const id = parseInt(t.startsWith('#') ? t.slice(1) : t, 10);
    if (!parsed.instances.has(id)) throw new Error(`expressId not found in model: #${id}`);
    return id;
  }
  const id = parsed.guidToId.get(t);
  if (id === undefined) throw new Error(`GlobalId not found in model: ${t}`);
  return id;
}

const REF_RE = /#(\d+)/g;

/** Forward reference closure: every instance transitively referenced by `seeds`. */
export function forwardClosure(seeds: Iterable<number>, parsed: ParsedStep, into: Set<number>): void {
  const stack = [...seeds];
  while (stack.length) {
    const id = stack.pop()!;
    if (into.has(id)) continue;
    into.add(id);
    const rec = parsed.instances.get(id);
    if (!rec) continue;
    REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REF_RE.exec(rec.body)) !== null) {
      const ref = parseInt(m[1], 10);
      if (!into.has(ref)) stack.push(ref);
    }
  }
}

/** Map each IfcLocalPlacement to its parent placement (or null when top-level). */
function placementParents(parsed: ParsedStep): Map<number, number | null> {
  const parents = new Map<number, number | null>();
  for (const inst of parsed.instances.values()) {
    if (inst.type !== 'IFCLOCALPLACEMENT') continue;
    const pm = /^\s*(#\d+|\$)/.exec(inst.body);
    parents.set(inst.id, pm && pm[1].startsWith('#') ? parseInt(pm[1].slice(1), 10) : null);
  }
  return parents;
}

/** Every product whose ObjectPlacement chains up through `storeyPlacementId`. */
function productsUnderPlacement(storeyPlacementId: number, parsed: ParsedStep): Set<number> {
  const parents = placementParents(parsed);
  const under = new Set<number>();
  for (const pid of parents.keys()) {
    let cur: number | null = pid;
    let guard = 0;
    while (cur != null && guard++ < 128) {
      if (cur === storeyPlacementId) {
        under.add(pid);
        break;
      }
      cur = parents.get(cur) ?? null;
    }
  }
  // Products referencing a selected placement.
  const seeds = new Set<number>();
  for (const inst of parsed.instances.values()) {
    REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REF_RE.exec(inst.body)) !== null) {
      if (under.has(parseInt(m[1], 10))) {
        seeds.add(inst.id);
        break;
      }
    }
  }
  return seeds;
}

/** Resolve a --storey selector (GUID / name / expressId) to its placement id. */
function resolveStoreyPlacement(token: string, parsed: ParsedStep): number {
  let storeyId: number | undefined;
  const t = token.trim();
  if (/^#?\d+$/.test(t)) {
    storeyId = parseInt(t.replace('#', ''), 10);
  } else if (parsed.guidToId.has(t)) {
    storeyId = parsed.guidToId.get(t);
  } else {
    // match by name (2nd-to-last-ish quoted arg); scan storeys for a Name match
    for (const inst of parsed.instances.values()) {
      if (inst.type !== 'IFCBUILDINGSTOREY') continue;
      if (inst.body.includes(`'${t}'`)) {
        storeyId = inst.id;
        break;
      }
    }
  }
  if (storeyId === undefined) throw new Error(`Storey not found: ${token}`);
  const storey = parsed.instances.get(storeyId);
  if (!storey || storey.type !== 'IFCBUILDINGSTOREY') {
    throw new Error(`#${storeyId} is ${storey?.type ?? 'missing'}, not an IfcBuildingStorey`);
  }
  // IfcBuildingStorey ObjectPlacement is attribute 6 (after Guid, Owner, Name,
  // Description, ObjectType) — the last #ref before LongName/Elevation. Grab the
  // placement ref: the storey references exactly one IfcLocalPlacement.
  const refs = [...storey.body.matchAll(REF_RE)].map((m) => parseInt(m[1], 10));
  const placementId = refs.find((r) => parsed.instances.get(r)?.type === 'IFCLOCALPLACEMENT');
  if (placementId === undefined) throw new Error(`Storey #${storeyId} has no IfcLocalPlacement`);
  return placementId;
}

/**
 * Assemble the kept-id set: the closure of `seedProducts` + context roots
 * (project/units/contexts + spatial skeleton) + spatial-containment relations
 * whose every member is kept (so no dangling references).
 */
export function buildSubset(seedProducts: Set<number>, parsed: ParsedStep): Set<number> {
  const keep = new Set<number>();
  forwardClosure(seedProducts, parsed, keep);

  // Context roots: the project + spatial skeleton, closed forward for units,
  // geometric contexts, and placement chains.
  const rootSeeds: number[] = [];
  for (const inst of parsed.instances.values()) {
    if (
      inst.type === 'IFCPROJECT' ||
      inst.type === 'IFCSITE' ||
      inst.type === 'IFCBUILDING' ||
      inst.type === 'IFCBUILDINGSTOREY'
    ) {
      rootSeeds.push(inst.id);
    }
  }
  forwardClosure(rootSeeds, parsed, keep);

  // Opening (void) + filler relations. These point FROM the relation TO the host
  // wall (RelatingBuildingElement), so walking only the wall's forward closure
  // never reaches its openings — the isolated wall would lose every window/door
  // cut and render as an uncut box, hiding the very void-cut defect the isolate
  // step exists to reproduce. Pull each IfcRelVoidsElement whose host is kept
  // (+ the IfcOpeningElement's forward closure), then each IfcRelFillsElement
  // whose opening is now kept (+ the filler window/door). The fixpoint loop lets
  // a fill relation see an opening that a voids relation added in an earlier pass.
  let grew = true;
  while (grew) {
    grew = false;
    for (const inst of parsed.instances.values()) {
      if (keep.has(inst.id)) continue;
      const refs = [...inst.body.matchAll(REF_RE)].map((m) => parseInt(m[1], 10));
      if (inst.type === 'IFCRELVOIDSELEMENT') {
        // refs: [OwnerHistory, RelatingBuildingElement, RelatedOpeningElement].
        const host = refs[refs.length - 2];
        const opening = refs[refs.length - 1];
        if (host !== undefined && opening !== undefined && keep.has(host)) {
          // Close over the relation itself, not just the opening: the rel's own
          // OwnerHistory must be kept too or the subset emits a dangling ref.
          forwardClosure([inst.id], parsed, keep);
          grew = true;
        }
      } else if (inst.type === 'IFCRELFILLSELEMENT') {
        // refs: [OwnerHistory, RelatingOpeningElement, RelatedBuildingElement(filler)].
        const opening = refs[refs.length - 2];
        const filler = refs[refs.length - 1];
        if (opening !== undefined && filler !== undefined && keep.has(opening)) {
          forwardClosure([inst.id], parsed, keep);
          grew = true;
        }
      }
    }
  }

  // Spatial relationships that connect kept products into the tree — but only
  // when EVERY referenced element is already kept, else we'd emit dangling refs.
  for (const inst of parsed.instances.values()) {
    if (
      inst.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE' ||
      inst.type === 'IFCRELAGGREGATES'
    ) {
      const refs = [...inst.body.matchAll(REF_RE)].map((m) => parseInt(m[1], 10));
      if (refs.length > 0 && refs.every((r) => keep.has(r))) keep.add(inst.id);
    }
  }
  return keep;
}

/** Serialize the kept ids back into a valid STEP file (sorted, header preserved). */
export function serializeSubset(keep: Set<number>, parsed: ParsedStep): string {
  const kept = [...keep].filter((id) => parsed.instances.has(id)).sort((a, b) => a - b);
  const lines = kept.map((id) => parsed.instances.get(id)!.full);
  return parsed.header + lines.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
}

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
  await gp.init();
  const res = await gp.process(bytes);
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
  const filePath = args.find((a) => !a.startsWith('-') && !isFlagValue(args, a));
  if (!filePath) {
    fatal(
      'Usage: ifc-lite extract-entities <file.ifc> [--product ID|GUID] [--type T] ' +
        '[--storey ID|GUID|name] [--detect [--top N]] --out sub.ifc [--view] [--port N]\n' +
        '       ifc-lite extract-entities <file.ifc> --detect --report [--json]',
    );
    return;
  }

  const buf = await readFile(filePath);
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
  logger.info(`Parsed ${parsed.instances.size} STEP instances from ${basename(filePath)}`);

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
  const seeds = new Set<number>();

  for (const token of getAllFlags(args, '--product').flatMap((v) => v.split(','))) {
    if (token) seeds.add(resolveToId(token, parsed));
  }
  for (const t of getAllFlags(args, '--type').flatMap((v) => v.split(','))) {
    const want = t.trim().toUpperCase();
    if (!want) continue;
    for (const inst of parsed.instances.values()) if (inst.type === want) seeds.add(inst.id);
  }
  for (const t of getAllFlags(args, '--storey').flatMap((v) => v.split(','))) {
    if (!t) continue;
    const placementId = resolveStoreyPlacement(t, parsed);
    for (const id of productsUnderPlacement(placementId, parsed)) seeds.add(id);
  }
  if (detect) {
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const rows = await triage(bytes);
    for (const r of rows.slice(0, topN)) seeds.add(r.expressId);
  }

  if (seeds.size === 0) {
    fatal('No entities selected. Use --product, --type, --storey, or --detect.');
    return;
  }
  if (!outPath) {
    fatal('Missing --out <sub.ifc> for extraction (or use --detect --report for a report).');
    return;
  }

  const keep = buildSubset(seeds, parsed);
  const out = serializeSubset(keep, parsed);
  await writeFile(outPath, out, 'latin1');
  process.stdout.write(
    `Extracted ${seeds.size} product(s) → ${keep.size} instances → ${outPath}\n`,
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
