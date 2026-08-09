/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite diff <file1.ifc> <file2.ifc>
 *
 * Compare two IFC files and report differences in entity counts,
 * types, and optionally property values.
 *
 * `--by-entity` adds a GlobalId-level added/removed/common count over the
 * entities `diff-scope.ts` decides are comparable, which is the same set
 * `--by-content` fingerprints — one answer about which entities a diff is
 * about, for both modes of the command.
 *
 * `--by-content` switches to the `@ifc-lite/diff` engine with content-keyed
 * matching and the identity-map sidecar (issue #1891) — see `diff-content.ts`.
 */

import { loadIfcFile } from '../loader.js';
import { hasFlag, getFlag, fatal, printJson, formatTable } from '../output.js';
import { IFC_ENTITY_NAMES } from '@ifc-lite/data';
import { contentDiffCommand } from './diff-content.js';
import { comparableGlobalIds } from './diff-scope.js';

const USAGE =
  'Usage: ifc-lite diff <file1.ifc> <file2.ifc> [--json] [--by-entity]\n' +
  '                     [--by-content] [--identity-out <map.json>] [--identity-in <map.json>]';

/** Flags that consume the following argument, so it is never mistaken for a
 *  positional file path. Deliberately only the flags this command owns: the
 *  shared `args.filter(a => !a.startsWith('-'))` idiom would have swallowed
 *  `--identity-out map.json` as a third file. */
const VALUE_FLAGS = new Set(['--identity-out', '--identity-in']);

export function diffPositionals(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    positional.push(arg);
  }
  return positional;
}

/** Read a path-valued flag, rejecting a missing value or one that is obviously
 *  the next flag — `--identity-out --json` would otherwise write a file called
 *  `--json`. */
function identityPath(args: string[], flag: string): string | undefined {
  if (!hasFlag(args, flag)) return undefined;
  const value = getFlag(args, flag);
  if (value === undefined || value.startsWith('-')) fatal(`${flag} requires a file path`);
  return value;
}

export async function diffCommand(args: string[]): Promise<void> {
  const positional = diffPositionals(args);
  // Exactly two, not "at least two". A third path is never a diff the command
  // can do, and silently dropping it is how `diff a.ifc b.ifc c.ifc` comes back
  // with a confident answer about the wrong pair of files.
  if (positional.length !== 2) fatal(USAGE);

  const [file1, file2] = positional;
  const jsonOutput = hasFlag(args, '--json');
  const byEntity = hasFlag(args, '--by-entity');

  // The identity-map flags only mean anything on the engine path, so they imply
  // it rather than being silently ignored next to the type-count diff.
  const identityOut = identityPath(args, '--identity-out');
  const identityIn = identityPath(args, '--identity-in');
  if (hasFlag(args, '--by-content') || identityOut !== undefined || identityIn !== undefined) {
    await contentDiffCommand({
      basePath: file1,
      headPath: file2,
      identityIn,
      identityOut,
      json: jsonOutput,
    });
    return;
  }

  process.stderr.write(`Loading files...\n`);
  const store1 = await loadIfcFile(file1);
  const store2 = await loadIfcFile(file2);

  // Type-level comparison
  const types1 = new Map<string, number>();
  const types2 = new Map<string, number>();
  for (const [typeName, ids] of store1.entityIndex.byType) {
    types1.set(typeName, ids.length);
  }
  for (const [typeName, ids] of store2.entityIndex.byType) {
    types2.set(typeName, ids.length);
  }

  const allTypes = new Set([...types1.keys(), ...types2.keys()]);
  const typeDiffs: { type: string; count1: number; count2: number; delta: number }[] = [];
  for (const t of allTypes) {
    const c1 = types1.get(t) ?? 0;
    const c2 = types2.get(t) ?? 0;
    if (c1 !== c2) {
      // Convert UPPERCASE STEP type name to PascalCase for display
      const displayName = IFC_ENTITY_NAMES[t] ?? t;
      typeDiffs.push({ type: displayName, count1: c1, count2: c2, delta: c2 - c1 });
    }
  }
  typeDiffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // Entity-level comparison by GlobalId, over the entities `diff-scope.ts`
  // says are comparable at all. Asking every row of the entity index for a
  // GlobalId instead — which is what this did — answered with a *Name* for
  // every resource entity whose STEP record starts with one, so two materials
  // sharing a name were compared as one entity, and it counted relationships
  // and property sets whose identity belongs to the things they connect.
  let entityDiff: { added: string[]; removed: string[]; common: number } | undefined;
  if (byEntity) {
    const globalIds1 = comparableGlobalIds(store1);
    const globalIds2 = comparableGlobalIds(store2);

    const added = [...globalIds2].filter(g => !globalIds1.has(g));
    const removed = [...globalIds1].filter(g => !globalIds2.has(g));
    const common = [...globalIds1].filter(g => globalIds2.has(g)).length;
    entityDiff = { added, removed, common };
  }

  const result = {
    file1: { path: file1, schema: store1.schemaVersion, entityCount: store1.entityCount },
    file2: { path: file2, schema: store2.schemaVersion, entityCount: store2.entityCount },
    entityCountDelta: store2.entityCount - store1.entityCount,
    typeDifferences: typeDiffs,
    entityDiff,
  };

  if (jsonOutput) {
    printJson(result);
    return;
  }

  // Human-readable output
  process.stdout.write(`\n  File 1: ${file1} (${store1.schemaVersion}, ${store1.entityCount} entities)\n`);
  process.stdout.write(`  File 2: ${file2} (${store2.schemaVersion}, ${store2.entityCount} entities)\n`);
  process.stdout.write(`  Delta:  ${result.entityCountDelta >= 0 ? '+' : ''}${result.entityCountDelta} entities\n\n`);

  if (typeDiffs.length > 0) {
    process.stdout.write(`  Type differences:\n`);
    const rows = typeDiffs.map(d => [
      d.type,
      String(d.count1),
      String(d.count2),
      (d.delta >= 0 ? '+' : '') + d.delta,
    ]);
    process.stdout.write(formatTable(['Type', 'File 1', 'File 2', 'Delta'], rows)
      .split('\n').map(l => '    ' + l).join('\n') + '\n');
  } else {
    process.stdout.write(`  No type differences.\n`);
  }

  if (entityDiff) {
    process.stdout.write(`\n  Entity comparison (by GlobalId, every IfcObjectDefinition):\n`);
    process.stdout.write(`    Common:  ${entityDiff.common}\n`);
    process.stdout.write(`    Added:   ${entityDiff.added.length}\n`);
    process.stdout.write(`    Removed: ${entityDiff.removed.length}\n`);
  }

  process.stdout.write('\n');
}
