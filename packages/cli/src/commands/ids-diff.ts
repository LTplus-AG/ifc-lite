/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite ids diff <before.ids> <after.ids> [--json | --md]
 *
 * Semantic diff of two IDS files: specifications and facets are paired by
 * the re-identification cascade (identifier, then name + applicability,
 * then similarity), so a renamed specification or an edited requirement
 * reads as a change. Exit 1 when the documents differ (CI use), 2 when one
 * cannot be read.
 */

import { diffIds, type IdsDiffEntry } from '@ifc-lite/ids-authoring';
import { printJson } from '../output.js';
import { EXIT_CLEAN, EXIT_FINDINGS, IdsUsageError, positionals, readIds, rejectUnknownFlags, runIdsSubcommand } from './ids-subcommand.js';

const DIFF_FLAGS = new Set(['--json', '--md']);
const MARK: Record<IdsDiffEntry['change'], string> = { added: '+', removed: '-', changed: '~' };

function markdown(before: string, after: string, entries: readonly IdsDiffEntry[]): string {
  const lines = [`## IDS changes: \`${before}\` → \`${after}\``, ''];
  if (entries.length === 0) return `${lines.join('\n')}No changes.\n`;
  for (const change of ['added', 'removed', 'changed'] as const) {
    const group = entries.filter((e) => e.change === change);
    if (group.length === 0) continue;
    lines.push(`### ${change[0].toUpperCase()}${change.slice(1)} (${group.length})`, '');
    for (const e of group) lines.push(`- ${e.text} (\`${e.path}\`)`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function idsDiffCommand(args: string[]): Promise<void> {
  await runIdsSubcommand(async () => {
    rejectUnknownFlags(args, DIFF_FLAGS, new Set());
    const [before, after, extra] = positionals(args, new Set());
    if (!before || !after || extra) throw new IdsUsageError('usage: ifc-lite ids diff <before.ids> <after.ids> [--json | --md]');
    if (args.includes('--json') && args.includes('--md')) throw new IdsUsageError('--json and --md cannot be combined');

    const diff = diffIds(await readIds(before), await readIds(after));
    const exit = diff.identical ? EXIT_CLEAN : EXIT_FINDINGS;
    if (args.includes('--json')) {
      printJson({ before, after, identical: diff.identical, entries: diff.entries });
      return exit;
    }
    if (args.includes('--md')) {
      process.stdout.write(markdown(before, after, diff.entries));
      return exit;
    }
    process.stdout.write(`\n  IDS diff: ${before} → ${after}\n\n`);
    for (const e of diff.entries) process.stdout.write(`  ${MARK[e.change]} ${e.text}\n      ${e.path}\n`);
    if (diff.entries.length > 0) process.stdout.write('\n');
    const count = diff.entries.length;
    process.stdout.write(`  ${count === 0 ? 'No changes' : `${count} change${count === 1 ? '' : 's'}`}\n\n`);
    return exit;
  });
}
