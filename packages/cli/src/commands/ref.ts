/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite ref` — manage named refs (mutable pointers to layer stacks)
 * in the local layer store (`.ifc-lite/refs.json`).
 *
 *   ref list                       List refs with stack hashes
 *   ref create <name> [--from R]   Create a ref (optionally copying R)
 *   ref move <name> --to <target>  Point a ref at another ref's stack or
 *                                  a comma-separated layer-id list
 *   ref protect <name> [...]       Set merge policy on a ref
 */

import { computeStackHash } from '@ifc-lite/ifcx';
import { getAllFlags, getFlag, hasFlag, printJson } from '../output.js';
import {
  getRef,
  readRefs,
  requireRef,
  resolveLayerId,
  setRef,
  shortId,
  storeFromArgs,
  type LayerStore,
  type RefEntry,
} from './layer-store.js';

export interface RefSummary {
  name: string;
  layers: string[];
  stackHash: string;
  policy?: RefEntry['policy'];
}

export function listRefs(store: LayerStore): RefSummary[] {
  const { refs } = readRefs(store);
  return Object.keys(refs)
    .sort()
    .map((name) => {
      const entry = refs[name];
      const summary: RefSummary = {
        name,
        layers: entry.layers,
        stackHash: computeStackHash(entry.layers),
      };
      if (entry.policy) summary.policy = entry.policy;
      return summary;
    });
}

export function createRef(store: LayerStore, name: string, from?: string): RefEntry {
  if (getRef(store, name)) {
    throw new Error(`Ref "${name}" already exists`);
  }
  const layers = from === undefined ? [] : [...requireRef(store, from).layers];
  const entry: RefEntry = { layers };
  setRef(store, name, entry);
  return entry;
}

/** Move a ref to another ref's stack or a comma-separated layer-id list. */
export function moveRef(store: LayerStore, name: string, to: string): RefEntry {
  const entry = requireRef(store, name);
  const target = getRef(store, to);
  const layers =
    target !== undefined
      ? [...target.layers]
      : to
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
          .map((id) => resolveLayerId(store, id));
  const updated: RefEntry = { ...entry, layers };
  setRef(store, name, updated);
  return updated;
}

export function protectRef(
  store: LayerStore,
  name: string,
  options: { requiredChecks?: string[]; requireHumanApproval?: boolean }
): RefEntry {
  const entry = requireRef(store, name);
  const policy = { ...entry.policy };
  if (options.requiredChecks !== undefined && options.requiredChecks.length > 0) {
    policy.requiredChecks = [...(policy.requiredChecks ?? []), ...options.requiredChecks];
  }
  if (options.requireHumanApproval) policy.requireHumanApproval = true;
  const updated: RefEntry = { ...entry, policy };
  setRef(store, name, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

export async function refCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printUsage();
    return;
  }
  const rest = args.slice(1);
  switch (sub) {
    case 'list':
      await refListCommand(rest);
      return;
    case 'create':
      await refCreateCommand(rest);
      return;
    case 'move':
      await refMoveCommand(rest);
      return;
    case 'protect':
      await refProtectCommand(rest);
      return;
    default:
      process.stderr.write(`Unknown ref subcommand: ${sub}\n`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  process.stdout.write(`Usage: ifc-lite ref <command> [...args]

Commands:
  list                              List refs with layer counts and stack hashes.
                                    Flags: --json, --store <dir>
  create <name> [--from <ref>]      Create a ref, optionally copying another
                                    ref's layer stack.
  move <name> --to <target>         Point a ref at another ref's stack or at a
                                    comma-separated list of layer ids.
  protect <name>                    Set merge policy on a ref.
                                    Flags: --require-check <spec> (repeatable),
                                           --require-human-approval

All commands honour --store <dir> (default: <cwd>/.ifc-lite).
`);
}

async function refListCommand(args: string[]): Promise<void> {
  const refs = listRefs(storeFromArgs(args));
  if (hasFlag(args, '--json')) {
    printJson(refs);
    return;
  }
  if (refs.length === 0) {
    process.stderr.write('No refs.\n');
    return;
  }
  for (const ref of refs) {
    const policyBits: string[] = [];
    if (ref.policy?.requireHumanApproval) policyBits.push('human-approval');
    for (const check of ref.policy?.requiredChecks ?? []) policyBits.push(`check:${check}`);
    const policySuffix = policyBits.length > 0 ? `  [${policyBits.join(', ')}]` : '';
    const top = ref.layers.length > 0 ? ` @ ${shortId(ref.layers[ref.layers.length - 1])}` : '';
    process.stdout.write(
      `${ref.name}  ${ref.layers.length} layer(s)${top}  ${ref.stackHash}${policySuffix}\n`
    );
  }
}

function positionalName(args: string[], usage: string): string {
  const name = args[0];
  if (!name || name.startsWith('-')) throw new Error(usage);
  return name;
}

async function refCreateCommand(args: string[]): Promise<void> {
  const name = positionalName(args, 'Usage: ifc-lite ref create <name> [--from <ref>]');
  const entry = createRef(storeFromArgs(args), name, getFlag(args, '--from'));
  if (hasFlag(args, '--json')) printJson({ name, ...entry });
  else process.stderr.write(`Created ref ${name} (${entry.layers.length} layer(s))\n`);
}

async function refMoveCommand(args: string[]): Promise<void> {
  const usage = 'Usage: ifc-lite ref move <name> --to <ref|layer-id,layer-id,...>';
  const name = positionalName(args, usage);
  const to = getFlag(args, '--to');
  if (!to) throw new Error(usage);
  const entry = moveRef(storeFromArgs(args), name, to);
  if (hasFlag(args, '--json')) printJson({ name, ...entry });
  else process.stderr.write(`Moved ref ${name} to ${entry.layers.length} layer(s)\n`);
}

async function refProtectCommand(args: string[]): Promise<void> {
  const name = positionalName(
    args,
    'Usage: ifc-lite ref protect <name> [--require-check <spec>]... [--require-human-approval]'
  );
  const entry = protectRef(storeFromArgs(args), name, {
    requiredChecks: getAllFlags(args, '--require-check'),
    requireHumanApproval: hasFlag(args, '--require-human-approval'),
  });
  if (hasFlag(args, '--json')) printJson({ name, ...entry });
  else process.stderr.write(`Protected ref ${name}\n`);
}
