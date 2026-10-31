// SPDX-License-Identifier: MPL-2.0
import { readFile, glob } from 'node:fs/promises';
import { join } from 'node:path';
import { isMainEntry } from './lib/is-main-entry.mjs';

const LANES = new Set(['native', 'cli', 'viewer']);

/** Bare registrations retain their historical native meaning; scoped rows use a tab. */
export async function requiredWitnesses(root, lane) {
  if (!LANES.has(lane)) throw new Error(`Unknown witness lane: ${lane}`);
  const required = [];
  for await (const relative of glob('tests/evidence/*/witnesses.txt', { cwd: root })) {
    const path = join(root, relative);
    const text = await readFile(path, 'utf8');
    for (const row of text.split(/\r?\n/)) {
      if (!row.trim() || row.startsWith('#')) continue;
      const parts = row.split('\t');
      const [scope, marker] = parts.length === 1 ? ['native', parts[0]] : parts;
      if (parts.length > 2 || !LANES.has(scope) || !marker?.trim()) {
        throw new Error(`Invalid witness registration in ${path}: ${row}`);
      }
      if (scope === lane) required.push({ path, marker });
    }
  }
  if (!required.length) throw new Error(`No registered witnesses for ${lane}`);
  return required;
}

export async function checkWitnesses({ root = '.', lane, log }) {
  const required = await requiredWitnesses(root, lane);
  // Node's spec/TAP reporters decorate diagnostics; Playwright's list reporter
  // emits the console record as its own line. Ignore ANSI colour/cursor codes.
  const lines = (await readFile(log, 'utf8')).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/).map(line => line.replace(/^(?:# |ℹ )/, ''));
  const missing = required.filter(({ marker }) => !lines.some(line => {
    // Native --nocapture writes may interleave, so preserve the old end anchor.
    if (lane === 'native') return line.endsWith(`sdk witness executed: ${marker}`);
    if (!line.startsWith(`${marker} `)) return false;
    const payload = JSON.parse(line.slice(marker.length + 1));
    return payload !== null && typeof payload === 'object';
  }));
  if (missing.length) throw new Error(`Missing ${lane} witnesses in ${log}:\n${missing.map(w => `${w.marker} (${w.path})`).join('\n')}`);
  return required.length;
}

if (isMainEntry(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--lane', '--log', '--root'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: --lane native|cli|viewer --log FILE [--root DIR]');
      options[args[i].slice(2)] = args[i + 1];
    }
    if (!options.log || !options.lane) throw new Error('--lane and --log are required');
    console.log(`${options.lane}: ${await checkWitnesses(options)} registered witnesses observed`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
