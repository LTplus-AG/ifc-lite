/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite storey` (#9025): list, add, rename, re-level and delete storeys in
 * an IFC file through `bim.store`, the same path as the viewer's storey
 * manager and the MCP `storey_*` tools. Geometry follows storeys: contents
 * move with their storey, walls attached to the storey above resize and
 * stairs refit; every refusal is reported before anything is written.
 */

import { writeFile } from 'node:fs/promises';
import { StepExporter } from '@ifc-lite/export';
import type { StoreyDeleteMode, StoreyLevelEdit, StoreySummary } from '@ifc-lite/create';
import { createHeadlessContext } from '../loader.js';
import { fatal, hasFlag, printJson } from '../output.js';

type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';

export const STOREY_USAGE = `Usage: ifc-lite storey <file.ifc> <action> [options]

Actions:
  list                                       Storeys, highest first: id, name, elevation, floor-to-floor, elements
  add --name N --elevation M --out F         Add a storey (copies the neighbouring storeys' placement)
  add --from <storey> [--below] --out F      Add above (or below) a storey with its neighbours' naming and spacing
  rename --storey <storey> --name N --out F  Rename a storey
  edit --storey <storey> --elevation M --out F
                                             Move that storey only; its contents move with it
  edit --storey <storey> --floor-height M --out F
                                             Set its floor-to-floor height; every storey above shifts
  delete --storey <storey> --out F [--move-to <storey> | --delete-contents]
                                             Delete a storey; one holding elements needs --move-to or --delete-contents

<storey> is a storey name, or #<express id> (a bare number is the id unless a storey has that name). Lengths are metres.

Options:
  --dry-run   Plan an edit or delete and report it (refusals, moves, resized walls, refit stairs); write nothing
  --json      Machine-readable output`;

function resolveStorey(rows: readonly StoreySummary[], value: string | undefined, flag: string): number {
  if (!value) fatal(`${flag} <storey> is required`);
  const available = () => rows.map((row) => `${row.Name} (#${row.expressId})`).join(', ') || '(none)';
  // `#36` is always the express id.
  if (/^#\d+$/.test(value!)) {
    const byId = rows.find((row) => row.expressId === Number(value!.slice(1)));
    return byId ? byId.expressId : fatal(`No storey has express id ${value}. Available: ${available()}`);
  }
  // The exact name first; letter case is only a fallback, so "Level 1" still names
  // one storey in a file that also has "level 1".
  const exact = rows.filter((row) => row.Name === value);
  const named = exact.length > 0 ? exact : rows.filter((row) => row.Name.toLowerCase() === value!.toLowerCase());
  const id = Number(value);
  const byId = /^\d+$/.test(value!) ? rows.find((row) => row.expressId === id) : undefined;
  // A bare number that is both one storey's id and another's name says neither: refuse it.
  if (byId && named.some((row) => row.expressId !== byId.expressId)) {
    return fatal(`"${value}" is #${byId.expressId}'s express id and also a storey name: write #${byId.expressId} for the id, or use the other storey's id`);
  }
  if (byId) return byId.expressId;
  if (named.length === 1) return named[0].expressId;
  return fatal(named.length > 1 ? `More than one storey is named "${value}": use #<express id>` : `Storey "${value}" not found. Available: ${available()}`);
}

/**
 * A value flag's operand. Absent is undefined; present without an operand (the
 * last argument, or followed by another `--flag`) is refused, never read as
 * absent: `--elevation` typed with no number must not fall back to a default.
 */
function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) return fatal(`${flag} needs a value`);
  return value;
}

function metres(value: string | undefined, flag: string): number {
  // `Number('')` is 0: a blank value must not read as ground level.
  const parsed = Number(value?.replace(',', '.'));
  if (value === undefined || value.trim() === '' || !Number.isFinite(parsed)) fatal(`${flag} must be a number of metres`);
  return parsed;
}

export async function storeyCommand(args: string[]): Promise<void> {
  const [filePath, action] = args.filter((a) => !a.startsWith('-') && !isFlagValue(args, a));
  if (!filePath || !action) fatal(STOREY_USAGE);
  const json = hasFlag(args, '--json');
  const dryRun = hasFlag(args, '--dry-run');
  const out = flagValue(args, '--out');
  const { bim, store, backend } = await createHeadlessContext(filePath!);
  // The CLI's headless backend holds one model under its fixed id.
  const modelId = 'default';
  const s = bim.store;
  const rows = () => s.listStoreyLevels(modelId);

  if (action === 'list') {
    const list = rows();
    if (json) { printJson(list); return; }
    for (const row of list) {
      const height = row.height === null ? '—' : `${row.height.toFixed(3)} m`;
      // The listing is the command's data: stdout, so it pipes (diagnostics stay on stderr).
      process.stdout.write(`#${row.expressId}\t${row.Name}\t${row.elevation.toFixed(3)} m\tfloor-to-floor ${height}\t${row.elementCount} elements\n`);
    }
    return;
  }

  const save = async (summary: Record<string, unknown>) => {
    if (!out) fatal('--out <file.ifc> is required (or use --dry-run)');
    const schema = (store.schemaVersion ?? 'IFC4') as Schema;
    const exported = new StepExporter(store, backend.getMutationView() ?? undefined).export({ schema, applyMutations: true });
    await writeFile(out!, exported.content);
    if (json) printJson({ ...summary, output: out, storeys: rows() });
    else process.stderr.write(`Written to ${out}\n`);
  };
  const run = <T>(write: () => T): T => {
    try { return write(); } catch (error) { return fatal(error instanceof Error ? error.message : String(error)); }
  };

  switch (action) {
    case 'add': {
      const from = flagValue(args, '--from');
      let Name = flagValue(args, '--name');
      let Elevation = flagValue(args, '--elevation') === undefined ? undefined : metres(flagValue(args, '--elevation'), '--elevation');
      let referenceStoreyId: number | undefined;
      if (from !== undefined) {
        referenceStoreyId = resolveStorey(rows(), from, '--from');
        const side = hasFlag(args, '--below') ? 'below' : 'above';
        const suggestion = s.suggestStorey(modelId, referenceStoreyId, side);
        Name ??= suggestion.Name;
        Elevation ??= suggestion.Elevation;
      }
      if (!Name || Elevation === undefined) fatal('add needs --name and --elevation, or --from <storey>');
      // A dry run makes the same add in memory, so it is refused exactly as the real one; only the file is not written.
      const ref = run(() => s.addStorey(modelId, { Name: Name!, Elevation: Elevation!, referenceStoreyId }));
      if (dryRun) { report({ action, Name, Elevation }, json); return; }
      if (!json) process.stderr.write(`Added ${Name} at ${Elevation!.toFixed(3)} m as #${ref.expressId}\n`);
      await save({ action, added: ref.expressId });
      return;
    }
    case 'rename': {
      const storeyId = resolveStorey(rows(), flagValue(args, '--storey'), '--storey');
      const Name = flagValue(args, '--name') ?? fatal('rename needs --name');
      run(() => s.renameStorey({ modelId, expressId: storeyId }, Name));
      if (dryRun) { report({ action, storey: storeyId, Name }, json); return; }
      await save({ action, storey: storeyId, Name });
      return;
    }
    case 'edit': {
      const storeyId = resolveStorey(rows(), flagValue(args, '--storey'), '--storey');
      const elevation = flagValue(args, '--elevation');
      const height = flagValue(args, '--floor-height');
      if ((elevation === undefined) === (height === undefined)) fatal('edit needs exactly one of --elevation or --floor-height');
      const edit: StoreyLevelEdit = elevation !== undefined
        ? { kind: 'elevation', storeyId, Elevation: metres(elevation, '--elevation') }
        : { kind: 'floorHeight', storeyId, Height: metres(height, '--floor-height') };
      const plan = s.planStoreyEdit(modelId, edit);
      const summary = {
        action, refusals: plan.refusals, notices: plan.notices,
        moves: plan.storeys.map(({ expressId, Name, from, to }) => ({ expressId, Name, from, to })),
        movedElements: plan.movedElementCount, resizedWalls: plan.walls.length, refitStairs: plan.stairs.length,
      };
      if (plan.refusals.length) {
        if (json) printJson(summary);
        return fatal(`Refused: ${plan.refusals.map((r) => r.message).join('; ')}`);
      }
      if (!json) {
        process.stderr.write(`Moves ${plan.storeys.length} storey(s) and ${plan.movedElementCount} element(s); resizes ${plan.walls.length} wall(s); refits ${plan.stairs.length} stair(s)\n`);
        for (const notice of plan.notices) process.stderr.write(`Note: ${notice.message} (${notice.elementIds.map((id) => `#${id}`).join(', ')})\n`);
      }
      if (dryRun) { if (json) printJson(summary); return; }
      run(() => s.editStorey(modelId, edit));
      await save(summary);
      return;
    }
    case 'delete': {
      const list = rows();
      const storeyId = resolveStorey(list, flagValue(args, '--storey'), '--storey');
      const moveTo = flagValue(args, '--move-to');
      const mode: StoreyDeleteMode = moveTo !== undefined
        ? { kind: 'move', targetStoreyId: resolveStorey(list, moveTo, '--move-to') }
        : hasFlag(args, '--delete-contents') ? { kind: 'deleteContents' } : { kind: 'empty' };
      const plan = s.planStoreyDelete({ modelId, expressId: storeyId }, mode);
      const summary = { action, storey: storeyId, mode: mode.kind, elements: plan.elementCount, refusals: plan.refusals };
      if (plan.refusals.length) {
        if (json) printJson(summary);
        return fatal(`Refused: ${plan.refusals.map((r) => r.message).join('; ')}`);
      }
      if (dryRun) { report(summary, json); return; }
      run(() => s.deleteStorey({ modelId, expressId: storeyId }, mode));
      await save(summary);
      return;
    }
    default:
      fatal(`Unknown storey action "${action}".\n\n${STOREY_USAGE}`);
  }
}

/** Positional values that belong to a value-taking flag are not the file or the action. */
function isFlagValue(args: readonly string[], value: string): boolean {
  const index = args.indexOf(value);
  const previous = index > 0 ? args[index - 1] : '';
  return ['--out', '--name', '--elevation', '--from', '--storey', '--floor-height', '--move-to'].includes(previous);
}

function report(summary: Record<string, unknown>, json: boolean): void {
  if (json) printJson({ ...summary, dryRun: true });
  else process.stderr.write(`Dry run: ${JSON.stringify(summary)}\n`);
}
