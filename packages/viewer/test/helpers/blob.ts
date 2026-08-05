/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Harness for testing the *pure* JavaScript that ships inside the browser blob
 * of `src/viewer-html.ts`.
 *
 * The viewer is one 1.4k-line template literal. Most of it is WebGL and DOM
 * wiring that cannot be exercised in node without faking a GL context — and a
 * fake GL context only proves the fake works. But a meaningful slice of the
 * blob is ordinary, browser-free logic: matrix math, chunk/typed-array
 * bookkeeping, colour resolution, bounds folding and the pick-colour codec.
 *
 * This harness lifts the *real shipped source text* of those declarations out
 * of the emitted HTML and evaluates it with its free variables supplied
 * explicitly. Nothing is re-implemented and no browser is simulated: if the
 * source moves or is reformatted, extraction throws instead of silently
 * testing nothing.
 */

import { getViewerHtml } from '../../src/viewer-html.js';

/** The HTML the server actually serves, for a fixed model name. */
export const VIEWER_HTML = getViewerHtml('harness.ifc');

/** The contents of the single `<script type="module">` block. */
export const SCRIPT: string = (() => {
  const m = /<script type="module">\n([\s\S]*?)\n<\/script>/.exec(VIEWER_HTML);
  if (!m) throw new Error('viewer-html.ts no longer emits a <script type="module"> block');
  return m[1];
})();

/**
 * Extract the source text of a top-level declaration from the blob.
 *
 * Relies on the file's consistent formatting: top-level declarations start at
 * column 0 and are closed by a lone `}`, `};`, `]` or `];` at column 0.
 * Throws loudly rather than returning a partial body.
 */
export function extractDecl(name: string): string {
  const lines = SCRIPT.split('\n');
  const startPattern = new RegExp(`^(?:async )?(?:function ${name}\\(|(?:const|let) ${name} =)`);
  const start = lines.findIndex((l) => startPattern.test(l));
  if (start === -1) throw new Error(`declaration '${name}' not found in the viewer blob`);

  // Single-line declaration (e.g. `const PICK_INDEX_MAX = 0xFFFFFF;`).
  if (/;\s*(\/\/.*)?$/.test(lines[start]) && !/[{[]\s*(\/\/.*)?$/.test(lines[start])) {
    return lines[start];
  }

  for (let i = start + 1; i < lines.length; i++) {
    if (/^[}\]];?$/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`declaration '${name}' has no column-0 terminator; formatting changed`);
}

/** Identifiers that mean the extracted code is *not* browser-free. */
const BROWSER_GLOBALS = /\b(document|window|navigator|gl|canvas|fetch|EventSource|requestAnimationFrame)\b/;

/**
 * Assert an extracted declaration touches no browser API. Guards the harness
 * against silently growing into a fake-DOM test as the viewer evolves.
 */
export function assertBrowserFree(name: string, src = extractDecl(name)): void {
  const hit = BROWSER_GLOBALS.exec(src);
  if (hit) {
    throw new Error(
      `'${name}' now references the browser global '${hit[1]}'; it is no longer node-testable`,
    );
  }
}

/**
 * Evaluate the given declarations of the blob in one shared scope.
 *
 * The lifted source runs in *this* realm (via `Function`), not a `vm` one, so
 * `Float32Array`, `Array` and friends are the same intrinsics the assertions
 * use. The blob's module-level state is supplied as named parameters, and the
 * returned object exposes each of them through a live accessor so a test can
 * observe what a command mutated.
 *
 * @param names declarations to lift, in dependency order
 * @param scope free variables the lifted code closes over — module-level state
 *   in the blob, plus explicit stubs for the DOM/GL seams it calls out to
 */
export function loadDecls(
  names: readonly string[],
  scope: Record<string, unknown> = {},
): Record<string, any> {
  const params = Object.keys(scope);
  const src = names.map((n) => extractDecl(n)).join('\n\n');
  const accessors = [
    ...names.map((n) => `${n}: { value: ${n}, enumerable: true }`),
    // Live views on the mutable state, so post-command reads see the new value.
    ...params.map(
      (p) =>
        `${p}: { get: () => ${p}, set: (v) => { ${p} = v; }, enumerable: true, configurable: true }`,
    ),
  ];
  const factory = new Function(
    ...params,
    `${src}\nreturn Object.defineProperties({}, { ${accessors.join(', ')} });`,
  );
  return factory(...params.map((p) => scope[p]));
}

/**
 * Extract the source between two exact anchors (inclusive of neither), for
 * logic that lives inline inside a larger browser-bound function.
 */
export function extractBetween(startAnchor: string, endAnchor: string): string {
  const a = SCRIPT.indexOf(startAnchor);
  if (a === -1) throw new Error(`anchor not found in the viewer blob: ${startAnchor}`);
  const b = SCRIPT.indexOf(endAnchor, a + startAnchor.length);
  if (b === -1) throw new Error(`anchor not found in the viewer blob: ${endAnchor}`);
  return SCRIPT.slice(a + startAnchor.length, b);
}
