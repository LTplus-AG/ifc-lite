/* SPDX-License-Identifier: MPL-2.0 */
/** Validate the static JS dependency closure without evaluating generated code.
 * Dynamic imports (including explicitly activated SDK assets) stay lazy and are
 * outside this generated-runtime packaging contract.
 */
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export function wasmRuntimeAssets(directory) {
  const root = realpathSync(directory);
  const assets = new Set();
  function inside(path) {
    const name = relative(root, path);
    return name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
  }
  function checked(name) {
    const path = resolve(root, name);
    if (!inside(path)) throw new Error(`runtime dependency escapes pkg: ${name}`);
    let actual;
    try { actual = realpathSync(path); }
    catch (error) { throw new Error(`missing runtime asset: ${name}`, { cause: error }); }
    if (!inside(actual) || actual !== path || !statSync(actual).isFile()) throw new Error(`foreign runtime asset: ${name}`);
    return path;
  }
  checked('ifc-lite_bg.wasm');
  assets.add('ifc-lite_bg.wasm');
  const pending = ['ifc-lite.js'];
  while (pending.length) {
    const name = pending.pop();
    if (assets.has(name)) continue;
    const path = checked(name);
    const source = ts.createSourceFile(name, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest,
      false, ts.ScriptKind.JS);
    if (source.parseDiagnostics.length) throw new Error(`invalid runtime JavaScript: ${name}`);
    assets.add(name);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier) continue;
      if (!ts.isStringLiteral(specifier)) throw new Error(`invalid static runtime import in ${name}`);
      const value = specifier.text;
      if ((!value.startsWith('./') && !value.startsWith('../')) || /[\\%?#\0]/.test(value)) {
        throw new Error(`foreign static runtime import in ${name}: ${value}`);
      }
      const target = resolve(dirname(path), value);
      if (!inside(target)) throw new Error(`runtime dependency escapes pkg: ${value}`);
      if (!['.js', '.mjs'].includes(extname(target))) {
        throw new Error(`unsupported static runtime import in ${name}: ${value}`);
      }
      pending.push(relative(root, target));
    }
  }
  return [...assets];
}


/** Static preflight only: reject unsafe output paths before any runtime writes.
 * This does not protect against another process changing paths after the check.
 */
export function assertWasmRuntimeDestinations(checkoutDirectory, assets) {
  const root = realpathSync(checkoutDirectory);
  for (const name of [...assets, '.npmignore', '.gitignore', 'ifc-lite.d.ts']) {
    const destination = resolve(root, 'packages/wasm/pkg', name);
    const parts = relative(root, destination).split(sep);
    let path = root;
    for (const [index, part] of parts.entries()) {
      path = resolve(path, part);
      let entry;
      try { entry = lstatSync(path); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const directory = index < parts.length - 1;
      if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile())) {
        throw new Error(`unsafe runtime destination: ${relative(root, path)}`);
      }
    }
  }
}
