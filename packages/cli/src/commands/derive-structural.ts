/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite derive-structural` — derive an IfcStructuralAnalysisModel from the
 * physical beams, columns, members, slabs, walls and footings, linked to them,
 * and write the augmented IFC (#9668). Runs `bim.store.planStructuralDerivation`
 * and `deriveStructuralAnalysisModel`; the rules are in `@ifc-lite/create`'s
 * `structural-derive-types.ts`.
 */

import { StepExporter } from '@ifc-lite/export';
import type { StructuralDerivationOptions } from '@ifc-lite/create';
import { createHeadlessContext } from '../loader.js';
import { getFlag, hasFlag, fatal, printJson, writeOutput } from '../output.js';

const USAGE = `Usage: ifc-lite derive-structural <file.ifc> --out <out.ifc> [options]

Derive a structural analysis model from the physical one: beams, columns and
members become curve members, slabs and walls surface members on their
mid-plane, member ends within the tolerance share a node, and footings carry
supports. Every derived item is linked to its physical element. Elements that
already have a structural counterpart are skipped, so a re-run writes nothing.

Options:
  --out <file.ifc>              Output IFC (omit with --dry-run)
  --tolerance <m>               Node merge tolerance in metres (default 0.05)
  --load-bearing-unknown <p>    Elements without LoadBearing: include | skip (default include)
  --support <type>              Support condition: pinned | fixed (default pinned)
  --dry-run                     Plan and report only; write nothing
  --json                        Machine-readable report`;

const VALUE_FLAGS = new Set(['--out', '--tolerance', '--load-bearing-unknown', '--support']);

export async function deriveStructuralCommand(args: string[]): Promise<void> {
  const filePath = args.find((a, i) => !a.startsWith('-') && !VALUE_FLAGS.has(args[i - 1]));
  if (!filePath) fatal(USAGE);
  const out = getFlag(args, '--out');
  const dryRun = hasFlag(args, '--dry-run');
  const json = hasFlag(args, '--json');
  if (!out && !dryRun) fatal('--out <file.ifc> is required (or use --dry-run to report only)');
  const tolerance = getFlag(args, '--tolerance');
  // Unset flags stay undefined, and the plan step fills in its defaults.
  const options: StructuralDerivationOptions = {
    tolerance: tolerance === undefined ? undefined : Number(tolerance),
    whenLoadBearingUnknown: getFlag(args, '--load-bearing-unknown') as StructuralDerivationOptions['whenLoadBearingUnknown'],
    supportType: getFlag(args, '--support') as StructuralDerivationOptions['supportType'],
  };

  const { bim, store, backend } = await createHeadlessContext(filePath);
  // The CLI's headless backend holds one model under its fixed id.
  const modelId = 'default';
  let plan;
  try {
    plan = bim.store.planStructuralDerivation(modelId, options);
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error));
  }
  const { report } = plan;
  const writes = !dryRun && report.counts.curveMembers + report.counts.surfaceMembers > 0;
  if (writes) {
    bim.store.deriveStructuralAnalysisModel(modelId, options);
    const schema = (store.schemaVersion ?? 'IFC4') as 'IFC2X3' | 'IFC4' | 'IFC4X3';
    await writeOutput(new StepExporter(store, backend.getMutationView() ?? undefined).export({ schema, applyMutations: true }).content, out);
  }

  if (json) {
    printJson({ input: filePath, output: writes ? out : null, dryRun, options: plan.options, ...report });
    return;
  }
  const c = report.counts;
  process.stderr.write(
    `${c.curveMembers} curve member(s), ${c.surfaceMembers} surface member(s), ${c.nodes} node(s), ` +
    `${c.supports} support(s) (${c.guessedSupports} guessed)\n`,
  );
  if (c.assumedLoadBearing) process.stderr.write(`${c.assumedLoadBearing} element(s) had no LoadBearing value and were assumed load-bearing\n`);
  if (report.unconnectedEnds.length) process.stderr.write(`${report.unconnectedEnds.length} member end(s) touch a member or surface they are not connected to\n`);
  for (const s of report.skipped) process.stderr.write(`skipped #${s.elementId} ${s.type}${s.name ? ` "${s.name}"` : ''}: ${s.reason} (${s.detail})\n`);
  if (!writes) process.stderr.write(dryRun ? 'Dry run: nothing written\n' : 'Nothing to derive: nothing written\n');
}
