// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

export const wasm2jsSha256 = 'fb4bc51da37e8ea8917552fdcb6edf8e1b77e9081c220579b78c50c429b29f2a';
export const wasm2jsUrl = 'https://storage.googleapis.com/webassembly/emscripten-releases-builds/linux/b412b6307e541b93dd93f01b61181e15c17302ec/wasm-binaries.tar.xz';
export const digest = data => createHash('sha256').update(data).digest('hex');
export function verifyExecutable(path, expected = wasm2jsSha256) {
  if (digest(readFileSync(path)) !== expected) throw new Error('wasm2js tool digest differs from pinned Binaryen 124 build');
  return path;
}

// Extraction writes only the selected executable's bytes, never archive paths.
export function extractPinnedExecutable(archive, output, expected = wasm2jsSha256) {
  const listing = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' });
  if (listing.status !== 0) throw new Error(`Cannot list translator archive: ${listing.stderr}`);
  const members = listing.stdout.split('\n').filter(name => name.endsWith('/bin/wasm2js'));
  if (members.length !== 1) throw new Error('Expected one wasm2js executable in pinned archive');
  const extraction = spawnSync('tar', ['-xOf', archive, '--', members[0]], { maxBuffer: 64 * 1024 * 1024 });
  if (extraction.status !== 0) throw new Error(`Cannot extract translator: ${extraction.stderr}`);
  if (digest(extraction.stdout) !== expected) throw new Error('Downloaded wasm2js digest mismatch');
  writeFileSync(output, extraction.stdout, { mode: 0o755 });
  chmodSync(output, 0o755);
}

export async function provisionWasm2js() {
  if (process.env.IFC_IMPORTED_WASM2JS) return verifyExecutable(process.env.IFC_IMPORTED_WASM2JS);
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Pinned imported translator supports Linux x86_64; supply the exact pinned IFC_IMPORTED_WASM2JS executable on other hosts');
  const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ifc-lite', 'tools');
  mkdirSync(cache, { recursive: true });
  const output = join(cache, `wasm2js-${wasm2jsSha256}`);
  if (existsSync(output)) return verifyExecutable(output);
  const temporary = mkdtempSync(join(cache, '.wasm2js-'));
  try {
    const response = await fetch(wasm2jsUrl);
    if (!response.ok || !response.body) throw new Error(`Translator download failed: HTTP ${response.status}`);
    const archive = join(temporary, 'sdk.tar.xz');
    await pipeline(response.body, createWriteStream(archive));
    const executable = join(temporary, 'wasm2js');
    extractPinnedExecutable(archive, executable);
    renameSync(executable, output);
    return verifyExecutable(output);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

// No committed output is touched until every producer validation succeeds.
export function publishGenerated(directory, produce) {
  const parent = dirname(directory);
  mkdirSync(parent, { recursive: true });
  const transaction = mkdtempSync(join(parent, '.imported-artifacts-'));
  const staged = join(transaction, 'staged');
  const backup = join(transaction, 'previous');
  mkdirSync(staged);
  try {
    produce(staged);
    if (existsSync(directory)) renameSync(directory, backup);
    try { renameSync(staged, directory); }
    catch (error) {
      if (existsSync(backup)) renameSync(backup, directory);
      throw error;
    }
  } finally { rmSync(transaction, { recursive: true, force: true }); }
}

export function wrapTranslator(translated) {
  const exportNames = [];
  const lazyBody = translated.replace(/^export var ([A-Za-z_$][\w$]*) = (.+);$/gmu, (_, name, expression) => {
    exportNames.push(name); return `var ${name} = ${expression};`;
  });
  if (/^\s*(?:import|export)\b/mu.test(lazyBody) || !['memory', 'imported_alloc', 'imported_free', 'imported_run'].every(name => exportNames.includes(name))) throw new Error('Pinned wasm2js export glue changed; inspect before wrapping');
  return `export function createImportedGeometryKernel() {\n${lazyBody}\nreturn { ${exportNames.join(', ')} };\n}\n`;
}

// The root [profile.release] tables, comments and blank lines removed, so cosmetic
// edits and unrelated workspace changes (versions, dependencies) never invalidate output.
export function releaseProfile(manifest) {
  const kept = [];
  let inside = false;
  for (const raw of manifest.split('\n')) {
    const line = raw.replace(/\s*#.*$/u, '').trimEnd();
    if (/^\[/u.test(line)) inside = /^\[profile\.release(?:[.\]])/u.test(line);
    if (inside && line) kept.push(line);
  }
  if (!kept.length) throw new Error('Root Cargo.toml has no [profile.release] section');
  return kept.join('\n');
}
