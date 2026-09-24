#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Guard: a `var(--name)` reference in the viewer's TS/TSX with no fallback
 * must resolve to a custom property that is either declared somewhere in
 * the viewer's CSS, or a documented runtime writer.
 *
 * BACKGROUND (#5479). `MeasurementVisuals.tsx` stroked and filled finished
 * measurement lines with `hsl(var(--primary))` at 16 sites. No `--primary`
 * custom property exists anywhere — `index.css`'s `@theme` block defines
 * `--color-primary` (a hex-derived value, not an hsl triple), so even
 * `hsl(var(--color-primary))` would have been invalid too. Once a drag
 * finished, the line's computed `stroke` was `none`: two floating endpoint
 * dots and a label were all that remained. Nothing caught it because
 * `tsc --strict` does not know CSS custom properties exist, and no test
 * asserted on rendered stroke colour. This gate makes the class fail CI.
 *
 * SCOPE. Scans every tracked `.ts`/`.tsx` file under `apps/viewer/src` for
 * `var(--name` references (see scripts/lib/css-vars.mjs for the detection
 * logic and its rationale, including why a `var(--x, fallback)` reference is
 * always safe and skipped). "Defined" means declared anywhere in a tracked
 * `.css` file under `apps/viewer/src` — `:root`, `.dark`, `.colorful`, or a
 * Tailwind v4 `@theme` block; the gate does not care which selector, only
 * that some rule in the viewer's CSS declares it.
 *
 * RUNTIME-WRITER ALLOWLIST. A var set by JS at runtime (never in a
 * stylesheet) is legitimate and cannot be seen by a scan of `.css` files.
 * Two documented mechanisms, both below:
 *  - FILE_ALLOWLIST: specific `--name`s scoped to the exact file that both
 *    writes and reads them (an inline `style={{ ['--x' as never]: value }}`
 *    a few lines above its `var(--x)` use, or a self-contained generated
 *    document that declares its own `:root` inside a template string).
 *    Scoped by FILE, not by name alone: a generic name like `--border`
 *    allowlisted globally would silently wave through a real bug in some
 *    OTHER file that happens to reuse the name with no writer nearby.
 *  - PREFIX_ALLOWLIST: Radix UI publishes `--radix-*` sizing/available-space
 *    vars on the DOM node it manages at runtime (available height, trigger
 *    width/height, ...); the exact suffix varies by primitive and version,
 *    so this is a prefix rule rather than an enumerated list.
 * Each row carries a reason a reviewer can check, same discipline as
 * check-asset-usage.mjs's ALLOWLIST. Adding a row is a real claim, not a way
 * to make the gate stop looking — if you can't point at the writer, fix the
 * reference instead of allowlisting it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractDefinedCssVars, findUndefinedCssVarRefs } from './lib/css-vars.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIR = 'apps/viewer/src';

// See the file-header comment above for what each row is claiming and why
// it is scoped the way it is.
const FILE_ALLOWLIST = [
  {
    file: 'apps/viewer/src/hooks/ids/idsExportService.ts',
    names: ['--pass', '--pass-bg', '--pass-border', '--fail', '--fail-bg', '--fail-border', '--warn', '--muted', '--border', '--bg', '--card', '--hover'],
    reason: 'Standalone IDS validation HTML report: the template string declares its own `:root { --pass: ...; --fail: ...; ... }` block (see the `:root {` line in this file) for the exported document, which never shares a DOM with the live viewer page. These tokens are not, and should not be, declared in apps/viewer/src/**/*.css.',
  },
  {
    file: 'apps/viewer/src/components/mcp/McpLanding.tsx',
    names: ['--accent', '--paper', '--p'],
    reason: "Set via inline style on the referencing (or an ancestor) element, e.g. `style={{ ['--accent' as never]: ACCENT }}`, immediately before the matching `var(--accent)` read — a runtime style-prop writer, not a CSS-defined token.",
  },
];

const PREFIX_ALLOWLIST = [
  {
    prefix: '--radix-',
    reason: 'Radix UI publishes layout vars (content-available-height, trigger width/height, ...) on the DOM node it manages at runtime; never declared in any stylesheet. See apps/viewer/src/components/ui/dropdown-menu.tsx and select.tsx.',
  },
  {
    prefix: '--overlay-',
    reason: 'The viewport overlay palette (#5483) is written onto <html> at runtime by applyOverlayTheme in apps/viewer/src/lib/viewport-ui/useOverlayThemeSync.ts, one value set per theme, from lib/viewport-ui/overlay-theme.ts; index.css only aliases these to Tailwind names.',
  },
];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

// `:(glob)` magic is required for `**` to cross directory boundaries — a
// bare pathspec glob to `git ls-files` does NOT recurse (`*` stops at `/`).
function listTrackedFiles(globSuffix) {
  const raw = git(['ls-files', '-z', '--', `:(glob)${SCAN_DIR}/${globSuffix}`]);
  return raw.split('\0').filter(Boolean);
}

const cssFiles = listTrackedFiles('**/*.css');
if (cssFiles.length === 0) {
  console.error(`❌ ${SCAN_DIR} has no tracked .css files. This check's scan dir is stale — fix
   SCAN_DIR in scripts/check-css-vars.mjs, don't ignore this.`);
  process.exit(1);
}

const definedVars = new Set();
for (const p of cssFiles) {
  const content = readFileSync(join(ROOT, p), 'utf-8');
  for (const name of extractDefinedCssVars(content)) definedVars.add(name);
}

const tsFiles = [...listTrackedFiles('**/*.ts'), ...listTrackedFiles('**/*.tsx')];
if (tsFiles.length === 0) {
  console.error(`❌ ${SCAN_DIR} has no tracked .ts/.tsx files. This check's scan dir is stale — fix
   SCAN_DIR in scripts/check-css-vars.mjs, don't ignore this.`);
  process.exit(1);
}

const sourceFiles = tsFiles.map((p) => ({ path: p, content: readFileSync(join(ROOT, p), 'utf-8') }));

const { violations, allowlistRowsUsed } = findUndefinedCssVarRefs({
  sourceFiles,
  definedVars,
  fileAllowlist: FILE_ALLOWLIST,
  prefixAllowlist: PREFIX_ALLOWLIST,
});

const staleRows = FILE_ALLOWLIST.filter((row) => !allowlistRowsUsed.includes(row));
if (staleRows.length > 0) {
  console.error(`❌ ${staleRows.length} FILE_ALLOWLIST row(s) in scripts/check-css-vars.mjs protect nothing
(no matching var(--name) reference found in the named file). A stale row is an
unreviewable claim — delete it, or fix the file it was written for:
${staleRows.map((r) => `   - ${r.file}: ${r.names.join(', ')}`).join('\n')}`);
  process.exit(1);
}

if (violations.length === 0) {
  console.log(`✅ Every fallback-less var(--name) reference across ${tsFiles.length} viewer TS/TSX file(s) resolves` +
    ` to a var declared in ${cssFiles.length} viewer CSS file(s) (${definedVars.size} declared)` +
    (FILE_ALLOWLIST.length > 0 ? `, or a documented runtime writer (${FILE_ALLOWLIST.reduce((n, r) => n + r.names.length, 0)} allowlisted name(s) across ${FILE_ALLOWLIST.length} file(s)).` : '.'));
  process.exit(0);
}

console.error(`❌ ${violations.length} var(--name) reference(s) with no fallback resolve to a custom property
that is declared nowhere in ${SCAN_DIR}/**/*.css and is not a documented runtime writer:
${violations.map((v) => `   - ${v.file}:${v.line}  var(${v.name})`).join('\n')}

Either point the reference at a real token (this is what #5479 did: 16 sites
of hsl(var(--primary)) -> var(--color-primary), because --primary was never
declared while --color-primary is, in the Tailwind v4 @theme block), or — if
it is genuinely written at runtime by JS rather than declared in CSS — add a
reasoned row to FILE_ALLOWLIST (or PREFIX_ALLOWLIST for a whole family of
runtime-published names) in scripts/check-css-vars.mjs.`);

process.exit(1);
