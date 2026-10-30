/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The chunks the page evaluates before it can paint: the module scripts
 * `index.html` loads, and every chunk they import statically, transitively.
 *
 * None of them may be `__tla`-wrapped. `vite-plugin-top-level-await`
 * moves a chunk's whole body into one `async` arrow function. Chrome compiles
 * a module's top level while the script streams in, off the main thread, but a
 * function inside it only when it is first called, on the main thread. A
 * wrapped chunk is therefore parsed in full on the main thread, inside the
 * app-start task: with the plugin on the app build, parsing the 5 MB entry
 * chunk's wrapper took about 100 ms of that task (225 to 265 ms on a
 * production build), and the wrapped chunks together
 * about 175 ms. Native top-level await (the build target is
 * `esnext`) needs no wrapper, so the app build does without the plugin; the
 * worker build keeps it, and a worker's chunks never reach this graph.
 */

/** The file names of the module scripts `html` loads, in document order. */
export function entryChunks(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
    const attrs = m[1];
    if (!/\btype\s*=\s*["']module["']/.test(attrs)) continue;
    const src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/);
    if (src) out.push(src[1].split('/').pop());
  }
  return out;
}

/**
 * Static imports and re-exports of sibling chunks: `import{a}from"./x.js"`,
 * `import"./x.js"`, `import * as n from"./x.js"`, `export{a}from"./x.js"`,
 * `export*from"./x.js"`, and the default and mixed forms `import a from"./x.js"`,
 * `import a,{b}from"./x.js"`, `import a,*as n from"./x.js"`. A dynamic `import("./x.js")` is not matched: the
 * parenthesis does not fit any form below, and a lazy chunk is not evaluated
 * at app start.
 */
const STATIC_DEPENDENCY =
  /\b(?:import|export)\s*(?:(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*\s*as\s+[\w$]+)\s*from\s*|[\w$]+\s+from\s*|\*\s*from\s*)?["']\.\/([^"']+\.js)["']/g;

/** The chunk files `text` imports statically. */
export function staticDependencies(text) {
  return [...new Set([...text.matchAll(STATIC_DEPENDENCY)].map((m) => m[1]))];
}

/**
 * The entry chunks of `html`, the chunks reached from them by static imports
 * (`sources`: file name -> text), and those of them in `wrappedChunks`: every
 * chunk the plugin rewrote, not only those that export `__tla`, because a
 * wrapped entry whose only import is dynamic exports none.
 * `missing` lists entries that are not among `sources`.
 */
export function wrappedOnEntryPath(html, sources, wrappedChunks) {
  const entries = entryChunks(html);
  const missing = entries.filter((file) => !sources.has(file));
  const reached = new Set();
  const queue = entries.filter((file) => sources.has(file));
  while (queue.length > 0) {
    const file = queue.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    for (const dep of staticDependencies(sources.get(file))) {
      if (sources.has(dep) && !reached.has(dep)) queue.push(dep);
    }
  }
  const wrapped = [...reached].filter((file) => wrappedChunks.has(file)).sort();
  return { entries, missing, reached, wrapped };
}

/**
 * The gate's verdict on the app-start graph: `{ entryPath }` when it was read
 * and nothing on it is wrapped, else `{ error }` with the message to print.
 * `html` is `index.html`'s text, or null when the file is missing; `label` is
 * its path as printed.
 */
export function checkEntryGraph(html, sources, wrappedChunks, label) {
  if (html === null) {
    return {
      error:
        `❌ ${label} does not exist, so the chunks the page loads at start cannot be\n` +
        `found. Rebuild the viewer:\n\n    pnpm turbo build --filter=@ifc-lite/viewer\n`,
    };
  }
  const entryPath = wrappedOnEntryPath(html, sources, wrappedChunks);
  if (entryPath.entries.length === 0 || entryPath.missing.length > 0) {
    return {
      error:
        `❌ ${label} loads ${entryPath.entries.length} module script(s)` +
        (entryPath.missing.length > 0 ? `, and ${entryPath.missing.join(', ')} is not among the emitted chunks` : '') +
        `, so the app-start graph was not checked.\n`,
    };
  }
  if (entryPath.wrapped.length > 0) {
    const listed = entryPath.wrapped.slice(0, 10).map((file) => `   ${file}\n`).join('');
    const more = entryPath.wrapped.length > 10 ? `   ... and ${entryPath.wrapped.length - 10} more\n` : '';
    return {
      error:
        `❌ ${entryPath.wrapped.length} of the ${entryPath.reached.size} chunk(s) the page evaluates at start ` +
        `are __tla-wrapped:\n\n${listed}${more}\n` +
        `A wrapped chunk's body is one async function, which is compiled on the main\n` +
        `thread when it first runs instead of while the script streams in, and the\n` +
        `app-start task grows by that parse. The app build uses native\n` +
        `top-level await: check that vite-plugin-top-level-await is not back in the\n` +
        `app build's plugins in apps/viewer/vite.config.ts (the worker build keeps it).\n`,
    };
  }
  return { entryPath };
}
