/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite ids fmt <rules.ids> [--check | --write]
 *
 * Canonical formatting. Without a flag the formatted XML goes to stdout.
 * `--check` exits 1 when the file is not already canonical; `--write`
 * rewrites it in place. The formatter never writes XML that reads back
 * with less content than the input: when this build's writer cannot carry
 * a value (some `info` fields, length/digit and conjunctive restrictions
 * until the full writer lands in `@ifc-lite/ids`), it exits 2 and names
 * the values instead of dropping them.
 */

import { writeFile } from 'node:fs/promises';
import { formatIds } from '@ifc-lite/ids-authoring';
import { writeIdsXml } from '@ifc-lite/rules';
import { EXIT_CLEAN, EXIT_FINDINGS, IdsUsageError, positionals, readText, rejectUnknownFlags, runIdsSubcommand } from './ids-subcommand.js';

const FMT_FLAGS = new Set(['--check', '--write']);
const MAX_LOST_SHOWN = 10;

export async function idsFmtCommand(args: string[]): Promise<void> {
  await runIdsSubcommand(async () => {
    rejectUnknownFlags(args, FMT_FLAGS, new Set());
    const [file, extra] = positionals(args, new Set());
    if (!file || extra) throw new IdsUsageError('usage: ifc-lite ids fmt <rules.ids> [--check | --write]');
    const check = args.includes('--check');
    const write = args.includes('--write');
    if (check && write) throw new IdsUsageError('--check and --write cannot be combined');

    const out = formatIds(await readText(file), writeIdsXml);
    if (!out.ok) {
      if (out.reason === 'parse') throw new IdsUsageError(`${file} does not parse as IDS (${out.message})`);
      const lost = out.lost ?? [];
      const shown = lost.slice(0, MAX_LOST_SHOWN).map((p) => `\n  - ${p}`).join('');
      const more = lost.length > MAX_LOST_SHOWN ? `\n  … and ${lost.length - MAX_LOST_SHOWN} more` : '';
      throw new IdsUsageError(`cannot format ${file} without loss: ${out.message}${shown}${more}`);
    }
    if (check) {
      process.stdout.write(out.changed ? `${file}: not formatted\n` : `${file}: formatted\n`);
      return out.changed ? EXIT_FINDINGS : EXIT_CLEAN;
    }
    if (write) {
      if (out.changed) await writeFile(file, out.xml, 'utf-8');
      process.stdout.write(out.changed ? `${file}: reformatted\n` : `${file}: already formatted\n`);
      return EXIT_CLEAN;
    }
    process.stdout.write(out.xml);
    return EXIT_CLEAN;
  });
}
