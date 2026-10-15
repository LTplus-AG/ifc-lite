/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, posix } from 'node:path';
import { list } from 'tar';
import { tokenizer, type Token } from 'acorn';
import { resolveNpmCommand } from './npm-command.js';

const valueOf = (token: Token): unknown => 'value' in token ? token.value : undefined;

function literalWorkerUrls(source: string): string[] {
  if (!source.includes('worker.')) return [];
  const recent: Token[] = [];
  const found: string[] = [];
  for (const token of tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })) {
    recent.push(token);
    if (recent.length > 11) recent.shift();
    if (recent.length !== 11) continue;
    const labels = recent.map(item => item.type.label).join(' ');
    if (labels !== 'new name ( string , import . name . name )' ||
        valueOf(recent[1]) !== 'URL' || valueOf(recent[7]) !== 'meta' || valueOf(recent[9]) !== 'url') continue;
    const specifier = valueOf(recent[3]);
    if (typeof specifier === 'string' && specifier.startsWith('.') && /worker\.[cm]?[jt]s(?:[?#]|$)/.test(specifier)) found.push(specifier);
  }
  return found;
}

/** A tarball's relative literal worker URLs must resolve to files it actually ships. */
export function missingWorkerAssets(archive: string): Array<{ file: string; specifier: string }> {
  const files = new Set<string>();
  const references: Array<{ file: string; specifier: string }> = [];
  list({ file: archive, sync: true, strict: true, onReadEntry(entry) {
    if (entry.type !== 'File') { entry.resume(); return; }
    const file = posix.normalize(entry.path);
    files.add(file);
    if (!/\.[cm]?js$/.test(file)) { entry.resume(); return; }
    const chunks: Buffer[] = [];
    entry.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    entry.on('end', () => {
      for (const specifier of literalWorkerUrls(Buffer.concat(chunks).toString('utf8'))) references.push({ file, specifier });
    });
  } });
  return references.filter(({ file, specifier }) => {
    const base = new URL(file.split('/').map(encodeURIComponent).join('/'), 'https://artifact.invalid/');
    const target = decodeURIComponent(new URL(specifier, base).pathname).slice(1);
    return !target.startsWith('package/') || !files.has(target);
  });
}

export function publishedWorkerAssetsPresent(packageName: string, version: string): boolean {
  const scratch = mkdtempSync(join(tmpdir(), 'ifclite-worker-artifact-'));
  try {
    const { command, args } = resolveNpmCommand(['pack', `${packageName}@${version}`, '--json', '--pack-destination', scratch]);
    const output = execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
    const result: unknown = JSON.parse(output);
    const first: unknown = Array.isArray(result) ? result[0] : undefined;
    if (!first || typeof first !== 'object' || !('filename' in first) || typeof first.filename !== 'string' ||
        basename(first.filename) !== first.filename) throw new Error('npm did not identify a packed artifact');
    const missing = missingWorkerAssets(join(scratch, first.filename));
    if (missing.length > 0) console.warn(`Skipping ${packageName}@${version}: worker assets are absent from its tarball: ` +
      missing.map(item => `${item.file}: ${item.specifier}`).join(', '));
    return missing.length === 0;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function hasWorkerFiles(metadata: unknown): boolean {
  if (!Array.isArray(metadata)) return false;
  return metadata.some((item: unknown) => item && typeof item === 'object' && 'files' in item && Array.isArray(item.files) &&
    item.files.some((file: unknown) => file && typeof file === 'object' && 'path' in file && typeof file.path === 'string' &&
      /worker\.[cm]?[jt]s$/.test(file.path)));
}
