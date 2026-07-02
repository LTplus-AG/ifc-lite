/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CLI-wide leveled logger. Writes to STDERR only: stdout is reserved for
 * command payloads and `--json` machine output (see output.ts), so human
 * diagnostics must never pollute it.
 *
 * A module-level singleton configured once in index.ts. The CLI is a
 * single-invocation, single-command process, so configure-once global state
 * is the idiomatic shape here; threading a context through ~30 command
 * signatures would be churn with no runtime benefit.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let currentLevel: LogLevel = 'info';

export const logger = {
  configure({ level }: { level: LogLevel }): void {
    currentLevel = level;
  },
  level(): LogLevel {
    return currentLevel;
  },
  error(msg: string): void {
    write('error', msg);
  },
  warn(msg: string): void {
    write('warn', msg);
  },
  info(msg: string): void {
    write('info', msg);
  },
  debug(msg: string): void {
    write('debug', msg);
  },
};

function write(level: LogLevel, msg: string): void {
  if (LEVEL_ORDER[level] > LEVEL_ORDER[currentLevel]) return;
  process.stderr.write(`${msg}\n`);
}

/** The reserved global flags. Long-form only: `-v` is already `--version`,
 * and short flags stay free for per-command use. */
const GLOBAL_FLAGS = new Set(['--verbose', '--quiet', '--debug', '--log-level']);

export interface Verbosity {
  level: LogLevel;
  /** True when `--debug` was passed (also unlocks stack traces on error). */
  debug: boolean;
  /** argv with the global flags AND the `--log-level` value stripped out. */
  rest: string[];
}

/**
 * Parse and STRIP the global verbosity flags from argv.
 *
 * Stripping is load-bearing: several commands pick their file path with
 * `args.find(a => !a.startsWith('-'))`, so an unstripped `--log-level debug
 * model.ifc` would make `debug` look like the positional file.
 *
 * Precedence: explicit `--log-level <level>` wins over the shorthands;
 * `--verbose` and `--debug` map to `debug`; `--quiet` maps to `error`.
 */
export function parseVerbosity(args: string[]): Verbosity {
  let level: LogLevel = 'info';
  let explicit: LogLevel | null = null;
  let debug = false;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!GLOBAL_FLAGS.has(arg)) {
      rest.push(arg);
      continue;
    }
    if (arg === '--verbose') {
      level = 'debug';
    } else if (arg === '--debug') {
      level = 'debug';
      debug = true;
    } else if (arg === '--quiet') {
      level = 'error';
    } else if (arg === '--log-level') {
      const value = args[i + 1];
      if (value === 'error' || value === 'warn' || value === 'info' || value === 'debug') {
        explicit = value;
        i++; // strip the value too
      } else {
        process.stderr.write(
          `Warning: --log-level expects error|warn|info|debug, got "${value ?? ''}"; ignoring\n`,
        );
        if (value !== undefined && !value.startsWith('-')) i++;
      }
    }
  }

  return { level: explicit ?? level, debug, rest };
}
