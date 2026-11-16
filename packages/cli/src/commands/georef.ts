/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite georef <subcommand> <file.ifc> ...
 *
 * Read and write a model's georeferencing through `bim.georef`. Subcommands
 * live in {@link GEOREF_SUBCOMMANDS}; a new one (e.g. a `check`) is one more
 * entry there plus a help row.
 */

import { writeFile } from 'node:fs/promises';
import { extractGeoreferencingOnDemand, parseModel } from '@ifc-lite/parser';
import { GeoreferencingError, readGeoreferencing, type GeoreferencingSetInput, type GeoreferencingState, type GeoreferencingWriteResult } from '@ifc-lite/sdk';
import { createHeadlessContext, loadIfcFile } from '../loader.js';
import { fatal, printJson } from '../output.js';
import { GeorefUsageError, georefInputFromArgs, parseGeorefArgs } from './georef-args.js';
import { describeGeoreferencing, verifyWritten } from './georef-format.js';

export const GEOREF_HELP = `
  ifc-lite georef — read and write georeferencing (IfcMapConversion / IfcProjectedCRS)

  Usage:
    ifc-lite georef show   <file.ifc> [--json]
    ifc-lite georef set    <file.ifc> --out F (--crs NAME | --epsg CODE) --map-unit U
                           --eastings E --northings N --height H [options] [--replace] [--json]
    ifc-lite georef update <file.ifc> --out F [options] [--json]
    ifc-lite georef remove <file.ifc> --out F [--json]

  CRS (IfcProjectedCRS):
    --crs NAME | --epsg CODE   Name, e.g. EPSG:2056 (--epsg 2056 writes "EPSG:2056")
    --map-unit U               METRE (any SI prefix, e.g. MILLIMETRE), FOOT, US SURVEY FOOT.
                               Required unless the CRS being replaced has the same Name and a MapUnit.
    --geodetic-datum D  --vertical-datum D  --map-projection P  --map-zone Z  --description T

  Map conversion (IfcMapConversion):
    --eastings E  --northings N  --height H (alias --orthogonal-height)   in map units
    --rotation DEG                         counter-clockwise from map easting to local x
    --x-axis-abscissa A --x-axis-ordinate O   the same rotation as a vector (both, or use --rotation)
    --scale S                              > 0; left unset when not given
    --factor-x X --factor-y Y --factor-z Z IFC4X3 / IFC4X3_ADD2 files only: writes IfcMapConversionScaled

  IFC2X3 has no such entities: set/update/remove write the ePSet_MapConversion and
  ePSet_ProjectedCRS property sets on the IfcSite, which ifc-lite and other readers understand.

  Refusals (exit 1, nothing written): a missing CRS, unit or offset; an unsupported unit;
  no IfcGeometricRepresentationContext (IFC2X3: no IfcSite); an existing georeferencing
  without --replace; a rotation angle and vector that disagree; a CRS rename by update that
  would keep the old datum or unit; factors outside IFC4X3. Every write is re-read from the
  written bytes before the file is saved.
`;

interface Subcommand {
  run(args: string[]): Promise<void>;
}

export const GEOREF_SUBCOMMANDS: Record<string, Subcommand> = {
  show: { run: showCommand },
  set: { run: (args) => writeCommand('set', args) },
  update: { run: (args) => writeCommand('update', args) },
  remove: { run: (args) => writeCommand('remove', args) },
};

export async function georefCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h' || rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(GEOREF_HELP + '\n');
    return;
  }
  const command = GEOREF_SUBCOMMANDS[sub];
  if (!command) fatal(`Unknown georef subcommand "${sub}". Expected one of: ${Object.keys(GEOREF_SUBCOMMANDS).join(', ')}.`);
  try {
    await command.run(rest);
  } catch (err) {
    if (err instanceof GeorefUsageError || err instanceof GeoreferencingError) fatal(err.message);
    throw err;
  }
}

function singleFile(positionals: string[], usage: string): string {
  if (positionals.length !== 1) throw new GeorefUsageError(`Usage: ${usage}`);
  return positionals[0];
}

async function showCommand(args: string[]): Promise<void> {
  const parsed = parseGeorefArgs(args, { values: false, out: false, replace: false });
  const file = singleFile(parsed.positionals, 'ifc-lite georef show <file.ifc> [--json]');
  const store = await loadIfcFile(file);
  const state = readGeoreferencing(store);
  if (parsed.booleans.has('--json')) {
    printJson({ file, georeferencing: state });
    return;
  }
  process.stdout.write(`\n  File:     ${file}\n${describeGeoreferencing(state)}\n`);
}

async function writeCommand(action: 'set' | 'update' | 'remove', args: string[]): Promise<void> {
  const parsed = parseGeorefArgs(args, { values: action !== 'remove', out: true, replace: action === 'set' });
  const file = singleFile(parsed.positionals, `ifc-lite georef ${action} <file.ifc> --out F ...`);
  const out = parsed.values.get('--out');
  if (!out) throw new GeorefUsageError(`georef ${action} writes a new file: pass --out F`);
  const input = georefInputFromArgs(parsed);

  const { bim, store } = await createHeadlessContext(file);
  const result: GeoreferencingWriteResult = action === 'set'
    ? bim.georef.set({ ...(input as GeoreferencingSetInput), replace: parsed.booleans.has('--replace') })
    : action === 'update' ? bim.georef.update(input) : bim.georef.remove();

  const content = bim.export.ifc(undefined, { schema: store.schemaVersion as 'IFC2X3' | 'IFC4' | 'IFC4X3' });
  const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
  // Read the georeferencing back from the bytes about to be written, with the
  // same extractor every reader uses, before anything touches the disk.
  const { store: written } = await parseModel(new TextEncoder().encode(text), { disableWorkerScan: true });
  const reread = readGeoreferencing(written);
  const mismatches = verifyWritten(result.state, reread, extractGeoreferencingOnDemand(written));
  if (mismatches.length > 0) {
    fatal(`The written file does not read back as requested; nothing was saved:\n  ${mismatches.join('\n  ')}`);
  }
  await writeFile(out, text, 'utf-8');

  if (parsed.booleans.has('--json')) {
    printJson({ file, output: out, action, storage: result.storage, removed: result.removed, mapUnit: result.mapUnit, notes: result.notes, georeferencing: reread });
    return;
  }
  const lines = [`georef ${action}: wrote ${out}`];
  if (result.removed.length > 0) lines.push(`  removed: ${result.removed.join(', ')}`);
  if (result.mapUnit) lines.push(`  MapUnit ${result.mapUnit.value} (${result.mapUnit.detail})`);
  for (const note of result.notes) lines.push(`  note: ${note}`);
  process.stderr.write(lines.join('\n') + '\n');
  process.stdout.write(describeGeoreferencing(reread as GeoreferencingState) + '\n');
}
