/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sha256 } from './exact-route-source.mjs';
export function sysrootQuery(args) {
  const query = ['--print', 'target-libdir'];
  for (const name of ['--target', '--sysroot']) {
    const i = args.indexOf(name);
    if (i >= 0) { if (!args[i + 1]) throw Error('incomplete compiler target/sysroot'); query.push(name, args[i + 1]); }
    else for (const arg of args) if (arg.startsWith(`${name}=`)) query.push(arg);
  }
  return query;
}
export function sysrootInputs(compiler, args, invoke = spawnSync) {
  const bare = args.flatMap((a, i) => a === '--extern' && !args[i + 1]?.includes('=') ? [args[i + 1]] : []);
  if (!bare.length) return [];
  if (bare.some(n => n !== 'proc_macro') || bare.length !== 1) throw Error('unknown bare compiler extern');
  const query = sysrootQuery(args), result = invoke(compiler, query, { encoding: 'utf8' });
  if (result.error || result.status !== 0 || !isAbsolute(result.stdout.trim())) throw Error('unbound compiler sysroot extern directory');
  const directory = result.stdout.trim();
  const names = readdirSync(directory).filter(n => /^libproc_macro-[a-f0-9]+\.rlib$/.test(n));
  if (names.length !== 1) throw Error('missing/ambiguous toolchain proc_macro library');
  const path = resolve(directory, names[0]);
  return [{ name: 'proc_macro', path, sha256: sha256(readFileSync(path)), query, directory }];
}
export function verifySysrootExtern(event, name) {
  const rows = event.sysrootExternsBefore;
  if (!Array.isArray(rows) || rows.length !== 1 || !isDeepStrictEqual(rows, event.sysrootExternsAfter)) throw Error('missing/changed sysroot extern trace');
  const row = rows[0];
  if (name !== 'proc_macro' || row.name !== name || !isAbsolute(row.path) || dirname(row.path) !== row.directory ||
      !/^libproc_macro-[a-f0-9]+\.rlib$/.test(basename(row.path)) || !/^[a-f0-9]{64}$/.test(row.sha256) ||
      !isDeepStrictEqual(row.query, sysrootQuery(event.args))) throw Error('unbound sysroot extern trace');
  return { name, kind: 'sysroot', sha256: row.sha256 };
}
