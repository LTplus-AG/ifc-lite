/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compare the exports a wasm-bindgen `.d.ts` declares with the exports its
 * `.js` glue actually provides.
 *
 * `packages/wasm/pkg/ifc-lite.d.ts` is committed and tracks the Rust crate at
 * this checkout; `ifc-lite.js` is a build artefact. `pnpm build:wasm:fetch`
 * fills the artefact from the last npm publish, which can predate the
 * checkout. A symbol the `.d.ts` declares and the `.js` lacks then compiles
 * fine and fails later, in a bundler, as `"x" is not exported by ...`. This
 * module names that gap at fetch time instead.
 *
 * Both scanners are line-anchored regexes over wasm-bindgen's fixed output
 * shape (`--target web`), not a JavaScript or TypeScript parser. Type-only
 * declarations (`interface`, `type`, `const enum`, `export type { ... }`) have
 * no runtime export and are ignored. `default` is a runtime export like any
 * other: a `.d.ts` that declares `export default function` demands the `.js`
 * provide one.
 */

/** Remove block comments and every `declare module ... { ... }` body from `.d.ts` text. */
function stripNonExports(dts) {
  let text = dts.replace(/\/\*[\s\S]*?\*\//g, '');
  for (;;) {
    const open = /^declare\s+module\b[^{\n]*\{/m.exec(text);
    if (!open) break;
    let depth = 1;
    let i = open.index + open[0].length;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
    text = text.slice(0, open.index) + text.slice(i);
  }
  return text;
}

/** Names from the body of an `export { a, b as c, type T }` list; `type`-modified items are skipped. */
function namesFromExportList(body) {
  const names = [];
  for (const raw of body.split(',')) {
    const item = raw.trim();
    if (!item || /^type\s/.test(item)) continue;
    const name = item.split(/\s+as\s+/).pop().trim();
    if (name) names.push(name);
  }
  return names;
}

/** Runtime names a wasm-bindgen `.d.ts` declares (function, class, const, enum, lists, default). */
export function declaredExports(dts) {
  const text = stripNonExports(dts);
  const names = new Set();
  for (const m of text.matchAll(
    /^export (?:declare )?(?:(?:abstract )?class|function\*?|const|let|var|enum) (?!enum\b)(\w+)/gm,
  )) {
    names.add(m[1]);
  }
  for (const m of text.matchAll(/^export (?!type\b)\{([^}]*)\}/gm)) {
    for (const name of namesFromExportList(m[1])) names.add(name);
  }
  if (/^export default\b/m.test(text)) names.add('default');
  return names;
}

/** Names a wasm-bindgen `.js` module exports, including `export { a, b as c }` and `export default`. */
export function providedExports(js) {
  const names = new Set();
  for (const m of js.matchAll(
    /^export (?:async )?(?:function\*?|class|const|let|var) (\w+)/gm,
  )) {
    names.add(m[1]);
  }
  for (const m of js.matchAll(/^export \{([^}]*)\}/gm)) {
    for (const name of namesFromExportList(m[1])) names.add(name);
  }
  if (/^export default\b/m.test(js)) names.add('default');
  return names;
}

/**
 * @param {string} dts committed `.d.ts` text (what this checkout expects)
 * @param {string} js `.js` text of the runtime (fetched or already installed)
 * @returns {{ missing: string[], extra: string[] }} `missing` is declared but
 *   not provided (the build breaks); `extra` is provided but not declared
 *   (the package is ahead of this checkout).
 */
export function compareWasmExports(dts, js) {
  const declared = declaredExports(dts);
  const provided = providedExports(js);
  return {
    missing: [...declared].filter((n) => !provided.has(n)).sort(),
    extra: [...provided].filter((n) => !declared.has(n)).sort(),
  };
}
