/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { classifyPath } from './lib/revert-oracle.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

export function addedPaths(root, base) {
  return execFileSync('git', ['diff', '--name-only', '-z', '--diff-filter=A', `${base}...HEAD`],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}

/** Only newly committed manifests opt in; existing slices cannot hijack a PR. */
export function discoverOracles(root, base = 'origin/main') {
  const added = new Set(addedPaths(root, base));
  return [...added].filter((path) => /^tests\/evidence\/[^/]+\/oracle\.json$/.test(path)).sort().map((path) => {
    const fail = (reason) => { throw new Error(`${path}: ${reason}. Remedy: add the production key, patch and witness in this PR and correct oracle.json; do not edit the workflow.`); };
    const file = (value, field) => {
      if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\')
          || value.split('/').some((part) => part === '..' || part === '.') || /[\0\r\n]/.test(value)) fail(`${field} must be a repository-relative file path`);
      try {
        const rel = relative(realpathSync(root), realpathSync(resolve(root, value)));
        if (rel.startsWith('..') || isAbsolute(rel) || !statSync(resolve(root, value)).isFile()) fail(`${field} escapes the repository or is not a file`);
      } catch (error) { fail(`${field} ${value} is unavailable (${error.message})`); }
    };
    file(path, 'manifest');
    let data;
    try { data = JSON.parse(readFileSync(resolve(root, path), 'utf8')); }
    catch (error) { fail(`invalid JSON (${error.message})`); }
    if (!data || Array.isArray(data) || data.issue !== 7955) fail('issue must be 7955');
    if (typeof data.why !== 'string' || !data.why.trim() || /[\r\n]/.test(data.why)) fail('why must be one nonempty line');
    file(data.key, 'key');
    if (classifyPath(data.key) !== 'production') fail('key must name a production file');
    if (!added.has(data.key)) fail(`key ${data.key} is not ADDED against ${base}`);
    file(data.mutation, 'mutation');
    if (data.test !== undefined) file(data.test, 'test');
    return { ...data, manifest: path };
  });
}

export function oracleArgs(oracles) {
  return oracles.flatMap(({ mutation, test }) => ['--mutation', mutation, ...(test ? ['--test', test] : [])]);
}

if (isMainEntry(import.meta.url)) {
  let base = 'origin/main', output;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (!['--base', '--output'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: revert-oracle-discover.mjs [--base REF] [--output FILE]');
    if (args[i] === '--base') base = args[++i];
    else output = args[++i];
  }
  const oracles = discoverOracles(process.cwd(), base);
  if (output) {
    const args = oracleArgs(oracles);
    writeFileSync(output, args.length ? `${args.join('\0')}\0` : '');
    console.log(`Discovered ${oracles.length} added oracle manifest(s)`);
  } else console.log(JSON.stringify(oracles, null, 2));
}
