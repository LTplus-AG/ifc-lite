#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// Linux release-input collector for a trusted, locally built adapter executable.
// ldd is deliberately never run on a downloaded/untrusted binary by CI.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isMainEntry } from './lib/is-main-entry.mjs';

export function linkedPaths(output) {
  if (/not found/.test(output)) throw new Error('Unresolved native dynamic dependency');
  const paths = new Set();
  for (const line of output.split('\n')) {
    const path = line.match(/(?:=>\s+|^\s*)(\/\S+)\s+\(/)?.[1];
    if (path) paths.add(path);
  }
  if (!paths.size) throw new Error('No dynamic runtime paths observed; inspect static linkage separately');
  return [...paths].sort();
}
function command(binary, args) {
  return execFileSync(binary, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}
function file(path) {
  const bytes = readFileSync(path);
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export function collect(binary, build) {
  const cache = readFileSync(join(build, 'CMakeCache.txt'), 'utf8');
  const compiler = cache.match(/^CMAKE_CXX_COMPILER:FILEPATH=(.+)$/m)?.[1];
  if (!compiler) throw new Error('CMake compiler identity missing');
  const dynamic = command('readelf', ['-d', binary]);
  const dependencies = linkedPaths(command('ldd', [binary])).map(path => {
    const resolved = realpathSync(path);
    let owners;
    try { owners = command('dpkg-query', ['--search', resolved]); }
    catch (error) {
      if (!error.status) throw error;
      owners = command('dpkg-query', ['--search', path]);
    }
    const owner = owners.split('\n').find(line => line.endsWith(`: ${resolved}`) || line.endsWith(`: ${path}`))?.split(': ')[0];
    if (!owner || owner.includes(', ')) throw new Error(`Ambiguous/unowned runtime: ${path}`);
    // eslint-disable-next-line no-template-curly-in-string -- dpkg-query's own format field, not a JS template
    const version = command('dpkg-query', ['--show', '--showformat=${Version}', owner]);
    const copyrightPath = `/usr/share/doc/${owner.split(':')[0]}/copyright`;
    return { ...file(resolved), loaderPath: path, package: owner, version,
      copyright: { ...file(copyrightPath), text: readFileSync(copyrightPath, 'utf8') } };
  });
  // Debian copyright files refer to these full texts; preserve them as review inputs.
  const commonLicenses = readdirSync('/usr/share/common-licenses').sort().map(name => {
    const path = join('/usr/share/common-licenses', name);
    return { ...file(path), text: readFileSync(path, 'utf8') };
  });
  return { format: 'ifc-lite.native-link-inventory/1', qualified: false,
    note: 'Observed dynamic closure and installed notices; static/compiler inlining and licence compatibility need human review.',
    sourceCommit: command('git', ['rev-parse', 'HEAD']).trim(), binary: file(binary),
    compiler, compilerVersion: command(compiler, ['--version']), dynamic, dependencies, commonLicenses };
}
if (isMainEntry(import.meta.url)) {
  const [binary, build, out] = process.argv.slice(2);
  if (!binary || !build || !out) throw new Error('Usage: node scripts/retained-native-link-inventory.mjs BINARY CMAKE_BUILD OUTPUT.json');
  writeFileSync(out, `${JSON.stringify(collect(binary, build), null, 2)}\n`, { flag: 'wx' });
}
