/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Detection logic behind scripts/check-css-vars.mjs (#5479). Pure functions
 * over strings so scripts/check-css-vars.test.mjs can assert on them
 * directly, without touching a real checkout — same split as
 * scripts/lib/asset-usage.mjs behind check-asset-usage.mjs.
 *
 * BACKGROUND. `apps/viewer/src/components/viewer/tools/MeasurementVisuals.tsx`
 * stroked and filled finished measurement lines with `hsl(var(--primary))` at
 * 16 sites. No `--primary` custom property is defined anywhere: the viewer's
 * Tailwind v4 `@theme` block defines `--color-primary` (a hex-derived value,
 * not an hsl triple), so even `hsl(var(--color-primary))` would have been
 * invalid. The finished line's computed `stroke` was `none` — two floating
 * endpoint dots and a label were all that remained once the drag ended.
 */

/**
 * Strip CSS comments before scanning for declarations, so a var name that
 * only ever appears in prose (`/* --tokyo-comment (#565f89) is ~2.5:1 *\/`)
 * cannot be mistaken for a real declaration, and so a genuinely
 * commented-out declaration cannot be mistaken for a live one either.
 */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Returns the set of custom-property names declared anywhere in a CSS
 * source string — `:root`, `.dark`, `.colorful`, `@theme`, any selector.
 * The gate does not care WHICH selector defines a var, only that some rule
 * in the viewer's CSS does — matching the issue's charter ("not defined
 * anywhere in the viewer's CSS ... including @theme blocks").
 */
export function extractDefinedCssVars(cssContent) {
  const clean = stripCssComments(cssContent);
  const defined = new Set();
  const re = /(--[a-zA-Z0-9-]+)\s*:/g;
  let m;
  while ((m = re.exec(clean))) {
    defined.add(m[1]);
  }
  return defined;
}

/**
 * Returns every `var(--name...)` reference in a TS/TSX source string, with
 * its 1-based line number and whether it carries a fallback (`var(--x, ...)`).
 *
 * A fallback makes the reference safe by construction: per the CSS spec, an
 * undefined custom property is a guaranteed-invalid value, and `var()` falls
 * back to its second argument whenever the referenced property has no value
 * — so `var(--background, #fff)` never computes to `none`/invalid, defined
 * or not. Only fallback-less references are worth failing the gate on; a
 * defined-with-fallback reference stays informational.
 */
export function extractVarReferences(sourceContent) {
  const refs = [];
  // CSS comments may sit on either side of the name (`var(--x /* note */)`);
  // skipping them is what keeps such a reference visible to the gate.
  const gap = String.raw`(?:\s|\/\*[\s\S]*?\*\/)*`;
  const re = new RegExp(String.raw`var\(` + gap + String.raw`(--[a-zA-Z0-9_-]+)` + gap + '([,)])', 'g');
  let m;
  while ((m = re.exec(sourceContent))) {
    const name = m[1];
    const hasFallback = m[2] === ',';
    const line = sourceContent.slice(0, m.index).split('\n').length;
    refs.push({ name, hasFallback, line });
  }
  return refs;
}

/**
 * @typedef {{ name: string, reason: string }} AllowlistPrefix
 * @typedef {{ file: string, names: string[], reason: string }} AllowlistFileRow
 */

/**
 * Decide whether a single var reference is allowed to stand undefined,
 * given:
 *  - `definedVars`: every `--name` declared anywhere in the viewer's CSS.
 *  - `fileAllowlist`: rows scoping specific names to a specific source file
 *    (exact repo-relative path) — a runtime writer local to that file, e.g.
 *    an inline `style={{ ['--x' as never]: value }}` a few lines above, or a
 *    self-contained generated document that declares its own `:root` inside
 *    a template string rather than in a stylesheet. Scoped by file (not by
 *    name alone) so a generic name like `--border` doesn't blanket-allow a
 *    real bug in a DIFFERENT file that happens to reuse it.
 *  - `prefixAllowlist`: rows allowing every name under a documented prefix
 *    (Radix UI's `--radix-*` runtime-published layout vars — never defined
 *    in any stylesheet, published on the DOM node Radix manages).
 *
 * Returns `{ allowed: boolean, reason?: string }`.
 */
export function isAllowedUndefined({ name, file, fileAllowlist, prefixAllowlist }) {
  for (const row of prefixAllowlist) {
    if (name.startsWith(row.prefix)) return { allowed: true, reason: row.reason };
  }
  for (const row of fileAllowlist) {
    if (row.file === file && row.names.includes(name)) return { allowed: true, reason: row.reason };
  }
  return { allowed: false };
}

/**
 * Scans a set of `{ path, content }` TS/TSX source files for `var(--name)`
 * references with no fallback whose `--name` is neither declared in
 * `definedVars` nor covered by the allowlists. Returns:
 *  - `violations`: `{ file, line, name }[]`, one per offending reference.
 *  - `allowlistRowsUsed`: the subset of `fileAllowlist` rows that matched at
 *    least one reference, so the gate can flag a row that protects nothing
 *    (stale allowlist entry) the same way check-asset-usage.mjs's ALLOWLIST
 *    comment asks reviewers to justify each row.
 */
export function findUndefinedCssVarRefs({ sourceFiles, definedVars, fileAllowlist, prefixAllowlist }) {
  const violations = [];
  const allowlistRowsUsed = new Set();

  for (const { path, content } of sourceFiles) {
    const refs = extractVarReferences(content);
    for (const ref of refs) {
      if (ref.hasFallback) continue;
      if (definedVars.has(ref.name)) continue;
      const verdict = isAllowedUndefined({ name: ref.name, file: path, fileAllowlist, prefixAllowlist });
      if (verdict.allowed) {
        const row = fileAllowlist.find((r) => r.file === path && r.names.includes(ref.name));
        if (row) allowlistRowsUsed.add(row);
        continue;
      }
      violations.push({ file: path, line: ref.line, name: ref.name });
    }
  }

  return { violations, allowlistRowsUsed: [...allowlistRowsUsed] };
}
