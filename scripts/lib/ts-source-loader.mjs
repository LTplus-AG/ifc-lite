/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Node `--experimental-loader` resolve hook used ONLY by
 * `server-browser-type-extractors.mjs`'s `loadHierarchySchemaModule` when it
 * is asked (by `check-server-browser-type-parity.test.mjs`'s schema-walk
 * mutation-control test, never by the real checker) to import
 * `relationship-schema-slots.ts` straight from SOURCE instead of the built
 * `dist/`.
 *
 * That file's own imports (and its `generated/*` dependency tree's) are
 * written the way every TS-with-`tsc`-build file in this repo is written:
 * `import { X } from './generated/schema-registry-by-version.js'` — a `.js`
 * specifier, because that is the extension `tsc` actually emits, and this
 * repo's TS files never spell out `.ts` in their own imports. Node's
 * `--experimental-strip-types` erases type syntax but does NOT rewrite
 * extensions, so importing the checked-in `.ts` sources directly makes
 * every one of those `.js` specifiers fail to resolve (`.js` genuinely
 * doesn't exist next to source that was never built). This hook is the
 * fallback: when a `.js` specifier fails to resolve and a same-named `.ts`
 * file exists right where it's expected, resolve to that `.ts` file instead
 * — exactly the substitution a `tsc` build would have made real by emitting
 * the `.js` in the first place. Nothing here reads or reasons about IFC
 * types; it only fixes an extension.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js') && context.parentURL) {
    const tsSpecifier = `${specifier.slice(0, -3)}.ts`;
    try {
      const candidate = new URL(tsSpecifier, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(tsSpecifier, context);
      }
    } catch {
      // Not a relative/file specifier this fallback applies to — fall
      // through to the normal resolution error below.
    }
  }
  return nextResolve(specifier, context);
}
