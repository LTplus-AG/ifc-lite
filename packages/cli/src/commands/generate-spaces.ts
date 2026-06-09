/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite generate-spaces` — derive IfcSpace from a model's walls (footprint)
 * with slab/roof-aware heights (storey datums), and write the augmented IFC.
 */

import { writeFile } from 'node:fs/promises';
import { createHeadlessContext } from '../loader.js';
import { getFlag, getAllFlags, hasFlag, fatal, printJson } from '../output.js';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { extractPropertiesOnDemand } from '@ifc-lite/parser';
import { generateSpaces, listStoreys, type GenerateSpacesAllOptions } from '@ifc-lite/create';

type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';

const USAGE = `Usage: ifc-lite generate-spaces <file.ifc> --out <out.ifc> [options]

Derive IfcSpace volumes from the building's walls (room footprints), using the
storey datums (slab levels) for floor-to-floor height.

Options:
  --out <file.ifc>        Output IFC with the new IfcSpace (omit with --dry-run)
  --storey <id|name|all>  Storey express id, name (substring), or all (default)
  --snap <m|auto>         Corner-closing tolerance in metres, or auto (default)
  --height <m|auto>       Space height in metres, or auto = floor-to-floor (default)
  --top-height <m>        Height for the topmost storey under auto (default 3)
  --min-area <m2>         Drop regions below this area (default 0.5)
  --name-pattern <p>      Name template; {n}=index, {storey}=storey name (default "Space {n}")
  --predefined-type <t>   IfcSpacePredefinedType (default INTERNAL)
  --boundary <mode>       Space boundary vs walls: center | inner | outer (default inner)
  --divider-type <t>      Extra element type to treat as a wall divider (repeatable)
  --dry-run               Detect + report only; write nothing
  --force                 Re-derive even if the model already has generated spaces (may duplicate)
  --list-storeys          List storeys (id, name, elevation) and exit
  --json                  Machine-readable output`;

export async function generateSpacesCommand(args: string[]): Promise<void> {
  const filePath = args.find((a) => !a.startsWith('-'));
  if (!filePath) fatal(USAGE);

  const out = getFlag(args, '--out');
  const storeyArg = getFlag(args, '--storey');
  const snapArg = getFlag(args, '--snap') ?? 'auto';
  const heightArg = getFlag(args, '--height') ?? 'auto';
  const minArea = Number(getFlag(args, '--min-area') ?? '0.5');
  const topHeight = Number(getFlag(args, '--top-height') ?? '3');
  const namePattern = getFlag(args, '--name-pattern');
  const predefinedType = getFlag(args, '--predefined-type');
  const boundaryArg = (getFlag(args, '--boundary') ?? 'inner') as 'center' | 'inner' | 'outer';
  if (!['center', 'inner', 'outer'].includes(boundaryArg)) fatal('--boundary must be center, inner, or outer');
  const dividerTypes = getAllFlags(args, '--divider-type');
  const dryRun = hasFlag(args, '--dry-run');
  const force = hasFlag(args, '--force');
  const json = hasFlag(args, '--json');
  const debug = hasFlag(args, '--debug');

  const { store } = await createHeadlessContext(filePath!);

  if (hasFlag(args, '--list-storeys')) {
    const sts = listStoreys(store);
    if (json) printJson(sts);
    else if (!sts.length) process.stderr.write('No IfcBuildingStorey found.\n');
    else for (const s of sts) process.stderr.write(`#${s.id}\t${s.name}\t(elev ${s.elevation.toFixed(2)} m)\n`);
    return;
  }

  if (!out && !dryRun) fatal('--out <file.ifc> is required (or use --dry-run to report only)');

  // ── resolve storey selection ──
  let storeys: 'all' | number[] = 'all';
  if (storeyArg && storeyArg.toLowerCase() !== 'all') {
    const all = listStoreys(store);
    const num = Number(storeyArg);
    if (Number.isFinite(num) && all.some((s) => s.id === num)) {
      storeys = [num];
    } else {
      const matched = all.filter((s) => s.name.toLowerCase().includes(storeyArg.toLowerCase()));
      if (!matched.length) {
        const avail = all.map((s) => `${s.name} (#${s.id})`).join(', ') || '(none)';
        fatal(`Storey "${storeyArg}" not found. Available: ${avail}`);
      }
      storeys = matched.map((s) => s.id);
    }
  }

  const snap = snapArg === 'auto' ? 'auto' : Number(snapArg);
  const height = heightArg === 'auto' ? 'auto' : Number(heightArg);
  if (snap !== 'auto' && !Number.isFinite(snap)) fatal('--snap must be a number (metres) or "auto"');
  if (height !== 'auto' && !Number.isFinite(height)) fatal('--height must be a number (metres) or "auto"');
  if (!Number.isFinite(minArea) || minArea < 0) fatal('--min-area must be a non-negative number');
  if (!Number.isFinite(topHeight) || topHeight <= 0) fatal('--top-height must be a positive number (metres)');

  // ── mutation overlay + editor ──
  const view = new MutablePropertyView(null, 'default');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);

  const opts: GenerateSpacesAllOptions = {
    storeys,
    snap,
    height,
    minArea,
    topStoreyHeight: topHeight,
    namePattern,
    predefinedType,
    extraDividerTypes: dividerTypes.length ? dividerTypes : undefined,
    boundaryMode: boundaryArg,
    dryRun,
    force,
    debug,
  };
  // The detector logs a per-storey `console.info` line (handy in the viewer's
  // devtools) and the auto-snap dry-runs multiply it; silence it for the CLI so
  // stdout stays clean — critical for `--json`. `--debug` keeps it.
  const origInfo = console.info;
  const origDebug = console.debug;
  if (!debug) {
    console.info = () => {};
    console.debug = () => {};
  }
  let res;
  try {
    res = generateSpaces(editor, store, opts);
  } finally {
    console.info = origInfo;
    console.debug = origDebug;
  }

  // Write whenever we emitted at least one space (other storeys may have been
  // skipped for already having spaces).
  if (!dryRun && out && res.totalEmitted > 0) {
    const schema = (store.schemaVersion ?? 'IFC4') as Schema;
    const exporter = new StepExporter(store, view);
    const exported = exporter.export({ schema, applyMutations: true });
    await writeFile(out, exported.content);
  }

  if (json) {
    printJson({
      input: filePath,
      output: !dryRun && out && res.totalEmitted > 0 ? out : null,
      dryRun,
      skippedExisting: res.skippedExisting,
      totalDetected: res.totalDetected,
      totalEmitted: res.totalEmitted,
      storeys: res.storeys.map((s) => ({
        id: s.id,
        name: s.name,
        elevation: s.elevation,
        height: s.height,
        snap: s.snapUsed,
        detected: s.result.detected.length,
        emitted: s.result.emitted.length,
        wallsConsidered: s.result.wallsConsidered,
        wallsContributing: s.result.wallsContributing,
        wallsSkipped: s.result.wallsSkipped.length,
        areas: s.result.detected.map((d) => Number(d.area.toFixed(2))),
      })),
    });
    return;
  }

  for (const s of res.storeys) {
    const areas = s.result.detected.map((d) => d.area.toFixed(1)).join(' / ') || '—';
    const emit = dryRun ? '' : ` → ${s.result.emitted.length} IfcSpace`;
    process.stderr.write(
      `${s.name} (#${s.id}, elev ${s.elevation.toFixed(2)} m): ${s.result.detected.length} room(s)${emit}` +
      `  [h=${s.height.toFixed(2)} m, snap=${s.snapUsed} m]  areas ${areas} m²\n`,
    );
  }
  process.stderr.write(
    `Total: ${res.totalDetected} room(s)` +
    (dryRun ? ' (dry-run — nothing written)' : `, ${res.totalEmitted} IfcSpace emitted`) +
    (res.skippedExisting ? `; skipped ${res.skippedExisting} overlapping an existing space` : '') + '\n',
  );
  if (out && !dryRun && res.totalEmitted > 0) process.stderr.write(`Written to ${out}\n`);
}
