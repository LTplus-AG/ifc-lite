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
 * declarations (`interface`, `type`) have no runtime export and are ignored.
 */

/** Runtime names a wasm-bindgen `.d.ts` declares (function, class, const, enum). */
export function declaredExports(dts) {
  const names = new Set();
  for (const m of dts.matchAll(
    /^export (?:declare )?(?:function|class|const|let|var|enum) (\w+)/gm,
  )) {
    names.add(m[1]);
  }
  return names;
}

/** Names a wasm-bindgen `.js` module exports, including `export { a, b as c }`. */
export function providedExports(js) {
  const names = new Set();
  for (const m of js.matchAll(
    /^export (?:async )?(?:function\*?|class|const|let|var) (\w+)/gm,
  )) {
    names.add(m[1]);
  }
  for (const m of js.matchAll(/^export \{([^}]*)\}/gm)) {
    for (const item of m[1].split(',')) {
      const name = item.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * @param {string} dts committed `.d.ts` text (what this checkout expects)
 * @param {string} js fetched `.js` text (what the published package provides)
 * @returns {{ missing: string[], extra: string[] }} `missing` is declared but
 *   not provided (the build breaks); `extra` is provided but not declared
 *   (the published package is ahead of this checkout).
 */
export function compareWasmExports(dts, js) {
  const declared = declaredExports(dts);
  const provided = providedExports(js);
  provided.delete('default'); // `__wbg_init as default`: declared as `export default function`
  return {
    missing: [...declared].filter((n) => !provided.has(n)).sort(),
    extra: [...provided].filter((n) => !declared.has(n)).sort(),
  };
}
