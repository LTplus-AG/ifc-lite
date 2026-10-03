/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createRequire } from 'node:module';
import { readdirSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileHash } from './interleaved-assets.mjs';
export async function installedClosure(seeds) {
  const queue = [...seeds], seen = new Set(), files = {}, normalized = {}, absentOptional = [];
  let fileCount = 0;
  while (queue.length) {
    if (seen.size > 1000 || queue.length > 10000) throw new Error('installed dependency closure bound');
    const { name, from, optional = false } = queue.shift();
    const request = createRequire(from);
    const manifest = (request.resolve.paths(name) ?? []).map(path => join(path, name, 'package.json')).find(existsSync);
    if (!manifest) {
      if (!optional) throw new Error(`required installed dependency absent: ${name} from ${from}`);
      absentOptional.push({ name, from }); continue;
    }
    const directory = realpathSync(dirname(manifest));
    if (seen.has(directory)) continue;
    seen.add(directory);
    const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const label = `${metadata.name}@${metadata.version}`;
    async function walk(path, depth = 0) {
      if (depth > 32) throw new Error('installed dependency depth bound');
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === 'node_modules') continue;
        const child = join(path, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`unqualified dependency symlink: ${child}`);
        if (entry.isDirectory()) await walk(child, depth + 1);
        else if (entry.isFile()) {
          if (++fileCount > 200000) throw new Error('installed dependency file bound');
          const hash = await fileHash(child), key = `${label}/${relative(directory, child)}`;
          if (normalized[key] && normalized[key] !== hash) throw new Error('installed package identity collision');
          files[child] = hash; normalized[key] = hash;
        }
      }
    }
    await walk(directory);
    const optionalDependencies = metadata.optionalDependencies ?? {};
    for (const dependency of new Set([...Object.keys(metadata.dependencies ?? {}), ...Object.keys(optionalDependencies)])) {
      queue.push({ name: dependency, from: join(directory, 'package.json'), optional: Object.hasOwn(optionalDependencies, dependency) });
    }
  }
  return { files, normalized, absentOptional, packageCount: seen.size };
}
