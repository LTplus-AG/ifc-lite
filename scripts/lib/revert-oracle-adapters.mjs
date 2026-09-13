/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cargoRunner } from './revert-oracle-cargo.mjs';
import { pythonRunner } from './revert-oracle-python.mjs';
import { detectRunner, rootScriptsRunner } from './revert-oracle.mjs';

/**
 * Executable manifest of the runtime families the oracle supports. Adding a
 * family means adding an adapter here; an unclaimed executable is a gap.
 */
export const REVERT_ORACLE_ADAPTERS = Object.freeze([
  {
    id: 'cargo', family: 'cargo', binary: 'cargo',
    claim: (context) => context.kind === 'cargo' && Boolean(context.target || context.moduleFilter),
    runner: (context) => cargoRunner(context.crate, context.features, context.target, context.moduleFilter),
    probeRunner: () => cargoRunner('revert-oracle-selfcheck', [], 'probe'),
  },
  {
    id: 'python-pytest', family: 'python', binary: 'python3',
    claim: (context) => context.kind === 'python',
    runner: (context) => pythonRunner([context.relFile]),
    probeRunner: (context) => pythonRunner([context.file]),
  },
  {
    id: 'root-node-test', family: 'node-test', binary: 'node',
    claim: (context) => context.kind === 'javascript' && context.rootPackage && /^scripts\/.*\.test\.(mjs|js|cjs)$/.test(context.file),
    runner: (context) => rootScriptsRunner([context.file]),
    probeRunner: (context) => ({ family: 'node-test', bin: 'node', args: ['--test', context.file] }),
  },
  {
    id: 'vitest', family: 'vitest', binary: 'vitest',
    claim: (context) => context.kind === 'javascript' && !context.rootPackage && /(^|[\s/])vitest\b/.test(context.script ?? ''),
    runner: (context) => detectRunner(context.script, [context.relFile]),
    probeRunner: (context) => {
      const runner = detectRunner('vitest run', [context.file]);
      return { ...runner, args: [...runner.args, '--globals'] };
    },
  },
  {
    id: 'node-test', family: 'node-test', binary: 'node',
    claim: (context) => context.kind === 'javascript' && !context.rootPackage && /--test\b/.test(context.script ?? ''),
    runner: (context) => detectRunner(context.script, [context.relFile]),
    probeRunner: (context) => detectRunner('node --test', [context.file]),
  },
  {
    id: 'typescript', family: 'typecheck', binary: 'node',
    claim: (context) => context.kind === 'typecheck',
    runner: () => ({ family: 'typecheck', bin: 'node', args: ['scripts/typecheck-tests.mjs'] }),
    probeRunner: (context) => ({ family: 'typecheck', bin: 'node', args: [joinPath(context.root, 'node_modules/typescript/bin/tsc'), '-p', joinPath(context.dir, 'tsconfig.json')] }),
  },
]);

const joinPath = (base, suffix) => `${base.replace(/[\\/]$/, '')}/${suffix}`;

export function claimRuntimeAdapter(context) {
  const adapter = REVERT_ORACLE_ADAPTERS.find((candidate) => candidate.claim(context));
  if (!adapter) return null;
  const runner = adapter.runner(context);
  return runner ? { adapter: adapter.id, runner } : null;
}
