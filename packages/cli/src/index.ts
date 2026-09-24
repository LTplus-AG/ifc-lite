#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite CLI — BIM toolkit for the terminal
 *
 * Query, validate, export, create, merge, convert, diff, and script IFC files
 * from the command line. Designed for both humans and LLM terminals.
 */

import { logger, parseVerbosity } from './logger.js';
import { fatal } from './output.js';
import { infoCommand } from './commands/info.js';
import { queryCommand } from './commands/query.js';
import { scheduleCommand } from './commands/schedule.js';
import { propsCommand } from './commands/props.js';
import { exportCommand } from './commands/export.js';
import { diagnoseGeometryCommand } from './commands/diagnose-geometry.js';
import { extractEntitiesCommand } from './commands/extract-entities.js';
import { anonymizeCommand } from './commands/anonymize.js';
import { idsCommand } from './commands/ids.js';
import { bcfCommand } from './commands/bcf.js';
import { clashCommand } from './commands/clash.js';
import { createCommand } from './commands/create.js';
import { evalCommand } from './commands/eval.js';
import { runCommand } from './commands/run.js';
import { schemaCommand } from './commands/schema.js';
import { mergeCommand } from './commands/merge.js';
import { convertCommand } from './commands/convert.js';
import { diffCommand } from './commands/diff.js';
import { rekeyCommand } from './commands/rekey.js';
import { validateCommand } from './commands/validate.js';
import { bsddCommand } from './commands/bsdd.js';
import { statsCommand } from './commands/stats.js';
import { mutateCommand } from './commands/mutate.js';
import { generateSpacesCommand } from './commands/generate-spaces.js';
import { askCommand } from './commands/ask.js';
import { viewCommand } from './commands/view.js';
import { analyzeCommand } from './commands/analyze.js';
import { lodCommand } from './commands/lod.js';
import { simplifyCommand } from './commands/simplify.js';
import { mcpCommand } from './commands/mcp.js';
import { extCommand } from './commands/ext.js';
import { layerCommand } from './commands/layer.js';
import { refCommand } from './commands/ref.js';
import { gymCommand } from './commands/gym.js';
import { deliveryCommand } from './commands/delivery.js';
import { checkCommand } from './commands/check.js';
import { flowCommand } from './commands/flow.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readPackageVersion } from '@ifc-lite/data';
import { buildHelp, buildCommandHelp } from './help.js';

// package.json sits one level above both `src/` and `dist/`.
const VERSION = readPackageVersion(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));

/**
 * Commands that write their result to a path given by `--out`.
 *
 * `--out` was listed under the global `Options:` block, and is not global: the
 * 21 commands not named here parse no such flag, so `info --json --out f.json`
 * wrote to stdout, created nothing and exited 0 (#5528). It is documented per
 * command instead -- each of these already shows `--out F` on its own line in
 * `Commands:` -- and passing it to any other command is refused rather than
 * swallowed.
 */
export const COMMANDS_WITH_OUT = new Set([
  'export', 'diagnose-geometry', 'extract-entities', 'anonymize', 'bcf', 'create',
  'merge', 'convert', 'rekey', 'mutate', 'generate-spaces', 'analyze', 'lod',
  'simplify', 'delivery', 'flow',
]);

/** Command being executed, captured for the top-level error handler. */
/**
 * Commands that handle `--help` themselves, with more detail than the global
 * `Commands:` block carries. Their handlers already tested for it; before
 * #5527 that branch was simply unreachable.
 */
const HELP_DELEGATING_COMMANDS = new Set(['layer', 'ref', 'ext']);

let activeCommand = '';
/** True when --debug was passed (stack traces on error). */
let debugFlag = false;

async function main(): Promise<void> {
  // Global verbosity flags are parsed and STRIPPED before dispatch so a
  // command's positional-argument scan never mistakes them for a file path.
  const verbosity = parseVerbosity(process.argv.slice(2));
  logger.configure({ level: verbosity.level });
  debugFlag = verbosity.debug;
  const args = verbosity.rest;

  const wantsHelp = args.includes('--help') || args.includes('-h');
  if (args.length === 0) {
    process.stdout.write(buildHelp(VERSION) + '\n');
    return;
  }
  if (wantsHelp) {
    // `--help` used to be answered globally BEFORE dispatch, with the command
    // still sitting in `args`, so all 37 subcommands printed the same page and
    // the real help written in `layer`/`ref`/`ext` was unreachable (#5527).
    const requested = args[0];
    if (HELP_DELEGATING_COMMANDS.has(requested)) {
      // These three write richer help of their own; let them answer.
    } else {
      const commandHelp = buildCommandHelp(VERSION, requested);
      process.stdout.write((commandHelp ?? buildHelp(VERSION)) + '\n');
      return;
    }
  }

  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`ifc-lite ${VERSION}\n`);
    return;
  }

  const command = args[0];
  activeCommand = command;
  const commandArgs = args.slice(1);

  if (commandArgs.includes('--out') && !COMMANDS_WITH_OUT.has(command)) {
    fatal(
      `\`${command}\` does not write to a file: it has no --out. ` +
        `Redirect its output instead, e.g. \`ifc-lite ${command} ... > out.json\`. ` +
        `Commands that do take --out: ${[...COMMANDS_WITH_OUT].sort().join(', ')}.`,
    );
  }

  switch (command) {
    case 'info':
      await infoCommand(commandArgs);
      break;
    case 'query':
      await queryCommand(commandArgs);
      break;
    case 'props':
      await propsCommand(commandArgs);
      break;
    case 'export':
      await exportCommand(commandArgs);
      break;
    case 'schedule':
      await scheduleCommand(commandArgs);
      break;
    case 'diagnose-geometry':
      await diagnoseGeometryCommand(commandArgs);
      break;
    case 'extract-entities':
      await extractEntitiesCommand(commandArgs);
      break;
    case 'anonymize':
      await anonymizeCommand(commandArgs);
      break;
    case 'ids':
      await idsCommand(commandArgs);
      break;
    case 'bcf':
      await bcfCommand(commandArgs);
      break;
    case 'clash':
      await clashCommand(commandArgs);
      break;
    case 'create':
      await createCommand(commandArgs);
      break;
    case 'eval':
      await evalCommand(commandArgs);
      break;
    case 'run':
      await runCommand(commandArgs);
      break;
    case 'schema':
      await schemaCommand(commandArgs);
      break;
    case 'merge':
      await mergeCommand(commandArgs);
      break;
    case 'convert':
      await convertCommand(commandArgs);
      break;
    case 'diff':
      await diffCommand(commandArgs);
      break;
    case 'rekey':
      await rekeyCommand(commandArgs);
      break;
    case 'validate':
      await validateCommand(commandArgs);
      break;
    case 'bsdd':
      await bsddCommand(commandArgs);
      break;
    case 'stats':
      await statsCommand(commandArgs);
      break;
    case 'mutate':
      await mutateCommand(commandArgs);
      break;
    case 'generate-spaces':
      await generateSpacesCommand(commandArgs);
      break;
    case 'ask':
      await askCommand(commandArgs);
      break;
    case 'view':
      await viewCommand(commandArgs);
      break;
    case 'analyze':
      await analyzeCommand(commandArgs);
      break;
    case 'lod':
      await lodCommand(commandArgs);
      break;
    case 'simplify':
      await simplifyCommand(commandArgs);
      break;
    case 'mcp':
      await mcpCommand(commandArgs);
      break;
    case 'ext':
      await extCommand(commandArgs);
      break;
    case 'layer':
      await layerCommand(commandArgs);
      break;
    case 'ref':
      await refCommand(commandArgs);
      break;
    case 'gym':
      await gymCommand(commandArgs);
      break;
    case 'delivery':
      await deliveryCommand(commandArgs);
      break;
    case 'check':
      await checkCommand(commandArgs);
      break;
    case 'flow':
      await flowCommand(commandArgs);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      process.stderr.write(`Run 'ifc-lite --help' for usage.\n`);
      process.exit(1);
  }
}

main().catch((err: Error) => {
  const label = activeCommand ? `Error [${activeCommand}]` : 'Error';
  process.stderr.write(`${label}: ${err.message}\n`);
  // Stack traces with --debug/--verbose/--log-level debug, or the legacy
  // DEBUG env var (kept for back-compat).
  if (debugFlag || logger.level() === 'debug' || process.env.DEBUG) {
    process.stderr.write((err.stack ?? '') + '\n');
  } else {
    process.stderr.write(
      `Hint: re-run with --debug for a stack trace, or \`ifc-lite ${activeCommand || '<command>'} --help\` for usage.\n`,
    );
  }
  process.exit(1);
});
