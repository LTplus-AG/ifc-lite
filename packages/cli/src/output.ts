/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Output formatting utilities for CLI commands.
 */

import { writeFile } from 'node:fs/promises';
import { logger } from './logger.js';

export type OutputFormat = 'json' | 'table' | 'csv';

/**
 * Write output to stdout or a file. Bytes are written verbatim (no string
 * round-trip, so output is not capped by the V8 max-string ceiling).
 */
export async function writeOutput(content: string | Uint8Array, outPath?: string): Promise<void> {
  if (outPath) {
    await writeFile(outPath, content);
    logger.info(`Written to ${outPath}`);
  } else {
    process.stdout.write(content);
    // Convenience newline for human-readable string output only; byte output
    // stays verbatim so `--format step > out.ifc` matches the exporter bytes.
    if (typeof content === 'string' && !content.endsWith('\n')) process.stdout.write('\n');
  }
}

/**
 * Format data as a simple ASCII table.
 */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => {
    let max = h.length;
    for (const row of rows) {
      const cell = row[i] ?? '';
      if (cell.length > max) max = cell.length;
    }
    return Math.min(max, 60);
  });

  const sep = widths.map(w => '─'.repeat(w + 2)).join('┼');
  const formatRow = (cells: string[]) =>
    cells.map((c, i) => ` ${(c ?? '').slice(0, widths[i]).padEnd(widths[i])} `).join('│');

  const lines: string[] = [];
  lines.push(formatRow(headers));
  lines.push(sep);
  for (const row of rows) {
    lines.push(formatRow(row));
  }
  return lines.join('\n');
}

/**
 * Print JSON to stdout.
 * Handles Map instances by converting them to plain objects.
 */
export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, (_key, value) => {
    if (value instanceof Map) {
      return Object.fromEntries(value);
    }
    return value;
  }, 2) + '\n');
}

/**
 * Print an error to stderr and exit.
 */
export function fatal(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

/**
 * Parse a CLI flag value from argv.
 */
export function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

/**
 * Collect all values for a repeated flag (e.g. --set A --set B → ['A', 'B']).
 */
export function getAllFlags(args: string[], flag: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) {
      results.push(args[i + 1]);
      i++; // skip value
    }
  }
  return results;
}

/**
 * Check if a boolean flag is present.
 */
export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Validate and parse a --viewer port string. Calls fatal() on invalid input.
 */
export function validateViewerPort(raw: string | undefined, flagName = '--viewer'): number | undefined {
  if (raw === undefined) return undefined;
  const port = parseInt(raw, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    fatal(`Invalid ${flagName} port: "${raw}" (must be 1–65535)`);
  }
  return port;
}

/**
 * Get positional arguments (non-flag arguments).
 */
export function getPositionalArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      // Skip flag and its value
      if (!args[i].startsWith('--no-') && i + 1 < args.length && !args[i + 1].startsWith('-')) {
        i++;
      }
      continue;
    }
    result.push(args[i]);
  }
  return result;
}
