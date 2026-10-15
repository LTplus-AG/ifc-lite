/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

// Shared by the API compatibility snapshot and generated developer reference.
/**
 * Resolve one `exports` map target to its declaration file, or null for
 * non-code targets (wasm assets, "./package.json", glob patterns).
 * Prefers an explicit `types` condition; otherwise infers the .d.ts
 * sitting next to the import/default JS target.
 */
function resolveDeclaration(pkgDir, key, target) {
  if (key.includes('*')) return null;
  if (target && typeof target === 'object') {
    if (typeof target.types === 'string') return resolve(pkgDir, target.types);
    for (const condition of ['import', 'default', 'node', 'browser', 'require']) {
      if (target[condition] === undefined) continue;
      const found = resolveDeclaration(pkgDir, key, target[condition]);
      if (found) return found;
    }
    return null;
  }
  if (typeof target !== 'string') return null;
  if (/\.d\.(ts|mts|cts)$/.test(target)) return resolve(pkgDir, target);
  const js = target.match(/^(.*)\.(js|mjs|cjs)$/);
  if (!js) return null; // .wasm, .json, … — not a code subpath
  const sibling = { js: '.d.ts', mjs: '.d.mts', cjs: '.d.cts' }[js[2]];
  const inferred = resolve(pkgDir, js[1] + sibling);
  return existsSync(inferred) ? inferred : resolve(pkgDir, `${js[1]}.d.ts`);
}

/** surface key ("@ifc-lite/mcp", "@ifc-lite/mcp/server") -> public .d.ts path */
export function collectEntryPoints(projectRoot) {
  const root = resolve(projectRoot);
  const entries = new Map();
  const missing = [];
  const packagesDir = join(root, 'packages');
  let packageCount = 0;
  for (const dir of readdirSync(packagesDir).sort()) {
    const pkgJsonPath = join(packagesDir, dir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    if (pkg.private === true) continue;
    packageCount += 1;
    const pkgDir = join(packagesDir, dir);
    // `exports` subpath map form; sugar forms (string / bare conditions)
    // describe only the root entry.
    const exportsMap =
      pkg.exports &&
      typeof pkg.exports === 'object' &&
      Object.keys(pkg.exports).every((k) => k.startsWith('.'))
        ? pkg.exports
        : { '.': pkg.exports ?? null };
    for (const [key, target] of Object.entries(exportsMap)) {
      const isRoot = key === '.';
      const declaration = isRoot
        ? resolve(
            pkgDir,
            pkg.types ??
              pkg.typings ??
              resolveDeclaration(pkgDir, key, target)?.slice(pkgDir.length + 1) ??
              'dist/index.d.ts',
          )
        : resolveDeclaration(pkgDir, key, target);
      if (!declaration) continue; // non-code subpath — nothing to guard
      const surfaceKey = isRoot ? pkg.name : `${pkg.name}/${key.slice(2)}`;
      if (existsSync(declaration)) {
        entries.set(surfaceKey, declaration);
      } else {
        missing.push({ name: surfaceKey, entry: relative(root, declaration) });
      }
    }
  }
  return { entries, missing, packageCount };
}

