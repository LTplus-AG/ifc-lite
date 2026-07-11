/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite layer` — layered change tracking over a local layer store
 * (`.ifc-lite/` of the cwd, override with --store <dir>).
 *
 * Publish content-addressed layers with provenance manifests, diff
 * composed states, merge candidates into refs (with three-way planning
 * and ref policy), and derive log/bake/revert/rebase from the same
 * state-based op model.
 *
 * Spec: docs/architecture/layer-prs/09-cli.md.
 */

import {
  layerCreateCommand,
  layerPublishCommand,
  layerStatusCommand,
} from './layer-publish.js';
import { layerDiffCommand } from './layer-diff.js';
import { layerMergeCommand } from './layer-merge.js';
import {
  layerBakeCommand,
  layerLogCommand,
  layerRebaseCommand,
  layerRevertCommand,
} from './layer-history.js';

export async function layerCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printUsage();
    return;
  }
  const rest = args.slice(1);
  switch (sub) {
    case 'publish':
      await layerPublishCommand(rest);
      return;
    case 'create':
      await layerCreateCommand(rest);
      return;
    case 'status':
      await layerStatusCommand(rest);
      return;
    case 'diff':
      await layerDiffCommand(rest);
      return;
    case 'merge':
      await layerMergeCommand(rest);
      return;
    case 'log':
      await layerLogCommand(rest);
      return;
    case 'bake':
      await layerBakeCommand(rest);
      return;
    case 'revert':
      await layerRevertCommand(rest);
      return;
    case 'rebase':
      await layerRebaseCommand(rest);
      return;
    default:
      process.stderr.write(`Unknown layer subcommand: ${sub}\n`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  process.stdout.write(`Usage: ifc-lite layer <command> [...args]

Commands:
  publish <delta.ifcx>     Publish a delta as a content-addressed layer.
                           Flags: --base <ref|->, --intent "<text>",
                                  --scope <claim> (repeatable),
                                  --principal <id>, --kind human|agent|hybrid,
                                  --strict-scope (exit 4 on scope mismatch),
                                  --json
                           Defaults --base/--intent/--scope from draft.json.
  create                   Record a draft descriptor (.ifc-lite/draft.json).
                           Flags: --base <ref>, --intent "<text>",
                                  --scope <claim> (repeatable)
  status                   Show the draft and whether its base ref moved.
  diff <side>              Diff composed states; a side is a ref, layer id,
                           or .ifcx file.
                           Flags: --against <side>, --components, --json
  merge <layer-id>         Merge a candidate into a ref (fast-forward or
                           three-way plan).
                           Flags: --into <ref>, --preview,
                                  --resolve ours|theirs,
                                  --waive <spec> --reason "<text>",
                                  --approved-by <principal>, --json
  log <ref>                Provenance log, newest first.       Flags: --json
  bake <ref> -o <out>      Materialize a tombstone-free flat document.
  revert <layer-id>        Publish an inverse layer and append it to a ref.
                           Conflicts (exit 2) when later layers touched the
                           same components.
                           Flags: --in <ref>, --resolve ours|theirs, --json
  rebase <layer-id>        Re-plan a candidate onto a ref's current stack
                           and publish the rebased layer.
                           Flags: --onto <ref>, --json

All commands honour --store <dir> (default: <cwd>/.ifc-lite).

Exit codes: 0 clean, 2 conflicts, 3 policy failure, 4 scope violation
(with --strict-scope), 1 generic errors.
`);
}
