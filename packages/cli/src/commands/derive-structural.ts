/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite derive-structural` — derive an IfcStructuralAnalysisModel from the
 * physical beams, columns, members, slabs, walls and footings, linked to them,
 * and write the augmented IFC (#9668). The rules are in `@ifc-lite/create`'s
 * `structural-derive-types.ts`.
 */

import { writeFile } from 'node:fs/promises';
import { createHeadlessContext } from '../loader.js';
import { getFlag, hasFlag, fatal, printJson } from '../output.js';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { extractPropertiesOnDemand } from '@ifc-lite/parser';
import {
  applyStructuralDerivation, planStructuralDerivation, readStructuralDerivationFacts, type StructuralDerivationOptions,
} from '@ifc-lite/create';

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

  const options: StructuralDerivationOptions = {};
  const tolerance = getFlag(args, '--tolerance');
  if (tolerance !== undefined) options.tolerance = Number(tolerance);
  const unknown = getFlag(args, '--load-bearing-unknown');
  if (unknown !== undefined) options.whenLoadBearingUnknown = unknown as StructuralDerivationOptions['whenLoadBearingUnknown'];
  const support = getFlag(args, '--support');
  if (support !== undefined) options.supportType = support as StructuralDerivationOptions['supportType'];

  const { store } = await createHeadlessContext(filePath);
  const schema = store.schemaVersion ?? 'IFC4';
  if (schema !== 'IFC2X3' && schema !== 'IFC4' && schema !== 'IFC4X3') fatal(`derive-structural: schema ${schema} is not supported; use IFC2X3, IFC4 or IFC4X3`);
  const view = new MutablePropertyView(null, 'default');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);

  let plan;
  try {
    plan = planStructuralDerivation(readStructuralDerivationFacts(store, editor), options);
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error));
  }
  const { report } = plan;
  const writes = !dryRun && report.counts.curveMembers + report.counts.surfaceMembers > 0;
  if (writes) {
    applyStructuralDerivation(editor, store, plan);
    const exported = new StepExporter(store, view).export({ schema, applyMutations: true });
    await writeFile(out as string, exported.content);
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
  if (writes) process.stderr.write(`Written to ${out}\n`);
  else process.stderr.write(dryRun ? 'Dry run: nothing written\n' : 'Nothing to derive: nothing written\n');
}
