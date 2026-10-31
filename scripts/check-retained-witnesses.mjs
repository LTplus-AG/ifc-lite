// SPDX-License-Identifier: MPL-2.0
import { readFile, glob } from 'node:fs/promises';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { isMainEntry } from './lib/is-main-entry.mjs';

const LANES = new Set(['native', 'cli', 'viewer']);

/** Bare registrations retain their historical native meaning; scoped rows use a tab. */
export async function requiredWitnesses(root, lane) {
  if (!LANES.has(lane)) throw new Error(`Unknown witness lane: ${lane}. Remedy: choose --lane native, cli or viewer.`);
  const required = [];
  const paths = [];
  try {
    for await (const relative of glob('tests/evidence/*/witnesses.txt', { cwd: root })) paths.push(join(root, relative));
  } catch (error) {
    throw new Error(`Cannot enumerate witness registrations under ${root}: ${error.message}. Remedy: run from the checkout root and restore read access to tests/evidence.`, { cause: error });
  }
  for (const path of paths) {
    let text;
    try { text = await readFile(path, 'utf8'); }
    catch (error) { throw new Error(`Cannot read registration ${path}: ${error.message}. Remedy: restore this file and its read permissions, then rerun the gate.`, { cause: error }); }
    for (const row of text.split(/\r?\n/)) {
      if (!row.trim() || row.startsWith('#')) continue;
      const parts = row.split('\t');
      const [scope, marker] = parts.length === 1 ? ['native', parts[0]] : parts;
      if (parts.length > 2 || !LANES.has(scope) || !marker?.trim()) {
        throw new Error(`Invalid witness registration in ${path}: ${row}. Remedy: use a native marker or native|cli|viewer<TAB>literal marker, then rerun the gate.`);
      }
      if (scope === lane) required.push({ path, marker });
    }
  }
  if (!required.length) throw new Error(`No registered witnesses for ${lane}. Remedy: restore the required ${lane} entries in tests/evidence/*/witnesses.txt; do not accept an empty lane.`);
  return required;
}

export async function checkWitnesses({ root = '.', lane, log }) {
  const required = await requiredWitnesses(root, lane);
  // Node's spec/TAP reporters decorate diagnostics; Playwright's list reporter
  // emits the console record as its own line. Ignore ANSI colour/cursor codes.
  let text;
  try { text = await readFile(log, 'utf8'); }
  catch (error) { throw new Error(`Cannot read ${lane} witness log ${log}: ${error.message}. Remedy: capture the actual unfiltered lane output at --log and check its read permissions.`, { cause: error }); }
  const lines = stripVTControlCharacters(text)
    .split(/\r?\n/).map(line => line.replace(/^(?:# |ℹ )/, ''));
  const missing = required.filter(({ marker }) => !lines.some((line, index) => {
    // Native --nocapture writes may interleave, so preserve the old end anchor.
    if (lane === 'native') return line.endsWith(`sdk witness executed: ${marker}`);
    if (!line.startsWith(`${marker} `)) return false;
    let payload;
    try { payload = JSON.parse(line.slice(marker.length + 1)); }
    catch (error) { throw new Error(`Malformed ${lane} witness ${marker} at ${log}:${index + 1}. Remedy: fix the post-assertion emitter to write valid JSON and recapture the lane log.`, { cause: error }); }
    if (payload === null || typeof payload !== 'object') throw new Error(`Malformed ${lane} witness ${marker} at ${log}:${index + 1}. Remedy: emit a JSON object or array after assertions, then recapture the lane log.`);
    return true;
  }));
  if (missing.length) throw new Error(`Missing ${lane} witnesses in ${log}:\n${missing.map(w => `${w.marker} (${w.path})`).join('\n')}\nRemedy: run the full ${lane} lane without grep/shard filtering; fix failed or skipped scenarios and capture their post-assertion records. Keep the registrations.`);
  return required.length;
}

if (isMainEntry(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--lane', '--log', '--root'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: --lane native|cli|viewer --log FILE [--root DIR]. Remedy: supply these flags and values.');
      options[args[i].slice(2)] = args[i + 1];
    }
    if (!options.log || !options.lane) throw new Error('--lane and --log are required. Remedy: use --lane native|cli|viewer --log FILE [--root DIR].');
    console.log(`${options.lane}: ${await checkWitnesses(options)} registered witnesses observed`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
