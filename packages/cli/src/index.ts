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
import { COMMANDS_WITH_OUT } from './out-flag-commands.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildHelp, buildCommandHelp } from './help.js';

// package.json sits one level above both `src/` and `dist/`.
async function readVersion(): Promise<string> {
  const { readPackageVersion } = await import('@ifc-lite/data/node');
  return readPackageVersion(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
}

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
    process.stdout.write(buildHelp(await readVersion()) + '\n');
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
      const version = await readVersion();
      const commandHelp = buildCommandHelp(version, requested);
      process.stdout.write((commandHelp ?? buildHelp(version)) + '\n');
      return;
    }
  }

  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`ifc-lite ${await readVersion()}\n`);
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

  // Keep diagnostics available when IFC command dependencies are broken.
  switch (command) {
    case 'doctor':
      await (await import('./commands/doctor.js')).doctorCommand(commandArgs);
      break;
    case 'info':
      await (await import('./commands/info.js')).infoCommand(commandArgs);
      break;
    case 'query':
      await (await import('./commands/query.js')).queryCommand(commandArgs);
      break;
    case 'props':
      await (await import('./commands/props.js')).propsCommand(commandArgs);
      break;
    case 'export':
      await (await import('./commands/export.js')).exportCommand(commandArgs);
      break;
    case 'schedule':
      await (await import('./commands/schedule.js')).scheduleCommand(commandArgs);
      break;
    case 'diagnose-geometry':
      await (await import('./commands/diagnose-geometry.js')).diagnoseGeometryCommand(commandArgs);
      break;
    case 'extract-entities':
      await (await import('./commands/extract-entities.js')).extractEntitiesCommand(commandArgs);
      break;
    case 'anonymize':
      await (await import('./commands/anonymize.js')).anonymizeCommand(commandArgs);
      break;
    case 'ids':
      await (await import('./commands/ids.js')).idsCommand(commandArgs);
      break;
    case 'bcf':
      await (await import('./commands/bcf.js')).bcfCommand(commandArgs);
      break;
    case 'clash':
      await (await import('./commands/clash.js')).clashCommand(commandArgs);
      break;
    case 'create':
      await (await import('./commands/create.js')).createCommand(commandArgs);
      break;
    case 'eval':
      await (await import('./commands/eval.js')).evalCommand(commandArgs);
      break;
    case 'run':
      await (await import('./commands/run.js')).runCommand(commandArgs);
      break;
    case 'schema':
      await (await import('./commands/schema.js')).schemaCommand(commandArgs);
      break;
    case 'merge':
      await (await import('./commands/merge.js')).mergeCommand(commandArgs);
      break;
    case 'convert':
      await (await import('./commands/convert.js')).convertCommand(commandArgs);
      break;
    case 'diff':
      await (await import('./commands/diff.js')).diffCommand(commandArgs);
      break;
    case 'rekey':
      await (await import('./commands/rekey.js')).rekeyCommand(commandArgs);
      break;
    case 'validate':
      await (await import('./commands/validate.js')).validateCommand(commandArgs);
      break;
    case 'bsdd':
      await (await import('./commands/bsdd.js')).bsddCommand(commandArgs);
      break;
    case 'stats':
      await (await import('./commands/stats.js')).statsCommand(commandArgs);
      break;
    case 'mutate':
      await (await import('./commands/mutate.js')).mutateCommand(commandArgs);
      break;
    case 'generate-spaces':
      await (await import('./commands/generate-spaces.js')).generateSpacesCommand(commandArgs);
      break;
    case 'ask':
      await (await import('./commands/ask.js')).askCommand(commandArgs);
      break;
    case 'view':
      await (await import('./commands/view.js')).viewCommand(commandArgs);
      break;
    case 'analyze':
      await (await import('./commands/analyze.js')).analyzeCommand(commandArgs);
      break;
    case 'lod':
      await (await import('./commands/lod.js')).lodCommand(commandArgs);
      break;
    case 'simplify':
      await (await import('./commands/simplify.js')).simplifyCommand(commandArgs);
      break;
    case 'mcp':
      await (await import('./commands/mcp.js')).mcpCommand(commandArgs);
      break;
    case 'ext':
      await (await import('./commands/ext.js')).extCommand(commandArgs);
      break;
    case 'layer':
      await (await import('./commands/layer.js')).layerCommand(commandArgs);
      break;
    case 'ref':
      await (await import('./commands/ref.js')).refCommand(commandArgs);
      break;
    case 'gym':
      await (await import('./commands/gym.js')).gymCommand(commandArgs);
      break;
    case 'delivery':
      await (await import('./commands/delivery.js')).deliveryCommand(commandArgs);
      break;
    case 'check':
      await (await import('./commands/check.js')).checkCommand(commandArgs);
      break;
    case 'semantic':
      await (await import('./commands/semantic.js')).semanticCommand(commandArgs);
      break;
    case 'flow':
      await (await import('./commands/flow.js')).flowCommand(commandArgs);
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
