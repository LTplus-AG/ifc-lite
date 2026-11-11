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
  --joint-reach <m>             How far a free member end may move along its axis to meet
                                another member (default: half that member's section + tolerance)
  --analysis-model-exists <p>   When the file has an analysis model: refuse | add (default refuse)
  --dry-run                     Plan and report only; write nothing
  --json                        Machine-readable report`;

const VALUE_FLAGS = new Set(['--out', '--tolerance', '--load-bearing-unknown', '--support', '--joint-reach', '--analysis-model-exists']);

export async function deriveStructuralCommand(args: string[]): Promise<void> {
  const filePath = args.find((a, i) => !a.startsWith('-') && !VALUE_FLAGS.has(args[i - 1]));
  if (!filePath) fatal(USAGE);
  for (const flag of VALUE_FLAGS) {
    const at = args.indexOf(flag);
    if (at !== -1 && (at + 1 >= args.length || args[at + 1].startsWith('--'))) fatal(`${flag} needs a value`);
  }
  const out = getFlag(args, '--out');
  const dryRun = hasFlag(args, '--dry-run');
  const json = hasFlag(args, '--json');
  if (!out && !dryRun) fatal('--out <file.ifc> is required (or use --dry-run to report only)');
  const metres = (flag: string) => {
    const value = getFlag(args, flag);
    // An empty value is not 0 metres.
    return value === undefined ? undefined : value.trim() === '' ? NaN : Number(value);
  };
  // Unset flags stay undefined, and the plan step fills in its defaults.
  const options: StructuralDerivationOptions = {
    tolerance: metres('--tolerance'),
    whenLoadBearingUnknown: getFlag(args, '--load-bearing-unknown') as StructuralDerivationOptions['whenLoadBearingUnknown'],
    supportType: getFlag(args, '--support') as StructuralDerivationOptions['supportType'],
    jointReach: metres('--joint-reach'),
    whenAnalysisModelExists: getFlag(args, '--analysis-model-exists') as StructuralDerivationOptions['whenAnalysisModelExists'],
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
  let { report } = plan;
  const existing = plan.existingAnalysisModels;
  if (existing.length > 0) {
    process.stderr.write(`The file already has ${existing.length} analysis model(s): ${existing.map((m) => `#${m.expressId}${m.derived ? ' (derived)' : ''}`).join(', ')}. `
      + (plan.options.whenAnalysisModelExists === 'add' ? 'The missing members go into a new one.\n' : 'Nothing is written unless --analysis-model-exists add.\n'));
  }
  const writes = !dryRun && report.counts.curveMembers + report.counts.surfaceMembers > 0;
  if (writes) {
    try {
      // Report what was written: derive plans again from the same state.
      ({ report } = bim.store.deriveStructuralAnalysisModel(modelId, options));
    } catch (error) {
      fatal(error instanceof Error ? error.message : String(error));
    }
    const schema = (store.schemaVersion ?? 'IFC4') as 'IFC2X3' | 'IFC4' | 'IFC4X3';
    await writeOutput(new StepExporter(store, backend.getMutationView() ?? undefined).export({ schema, applyMutations: true }).content, out);
  }

  if (json) {
    printJson({ input: filePath, output: writes ? out : null, dryRun, options: plan.options, existingAnalysisModels: existing, ...report });
    return;
  }
  const c = report.counts;
  process.stderr.write(
    `${c.curveMembers} curve member(s), ${c.surfaceMembers} surface member(s), ${c.nodes} node(s), ` +
    `${c.supports} support(s) (${c.guessedSupports} guessed)\n`,
  );
  if (c.assumedLoadBearing) process.stderr.write(`${c.assumedLoadBearing} element(s) had no LoadBearing value and were assumed load-bearing\n`);
  if (c.extendedEnds) process.stderr.write(`${c.extendedEnds} member end(s) moved along their axis to meet another member (largest ${Math.max(...report.extendedEnds.map((e) => Math.abs(e.distance))).toFixed(3)} m)\n`);
  if (c.freeEnds) process.stderr.write(`${c.freeEnds} free member end(s) meet no other member or support\n`);
  if (report.unconnectedEnds.length) process.stderr.write(`${report.unconnectedEnds.length} node(s) touch a member or surface they are not connected to\n`);
  for (const s of report.skipped) process.stderr.write(`skipped #${s.elementId} ${s.type}${s.name ? ` "${s.name}"` : ''}: ${s.reason} (${s.detail})\n`);
  if (!writes) process.stderr.write(dryRun ? 'Dry run: nothing written\n' : 'Nothing to derive: nothing written\n');
}
