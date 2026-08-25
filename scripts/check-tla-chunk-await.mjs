#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Guard: no emitted chunk may statically import a `__tla`-wrapped chunk
 * without also importing (and thus being able to await) that chunk's
 * `__tla` promise.
 *
 * `vite-plugin-top-level-await` wraps a chunk's body in a deferred `__tla`
 * promise whenever the chunk needs transforming -- which happens whenever the
 * chunk contains a dynamic `import()`, NOT only when it contains a genuine
 * top-level `await`. When it wraps a chunk, every export of that chunk
 * becomes a `var` assigned only once `__tla` resolves. The plugin correctly
 * propagates "you must wait for me" to a STATIC importer that is itself
 * already being transformed (it adds `, __tla as __tla_N` to the import
 * clause and folds `__tla_N` into its own `Promise.all([...])` wrapper --
 * see the real example this check keys off, below). But a static importer
 * that has no dynamic imports and no top-level await of its own is never
 * flagged for transformation, so it stays synchronous and evaluates against
 * bindings that are still unassigned `var`s. That throws a `TypeError:
 * <name> is not a function` during module evaluation, before any React error
 * boundary exists -- a white screen (issue #2246, behind the outage in
 * #2243).
 *
 * This is a bundle-level check, not a source-level one, deliberately: the
 * defect lives in what the splitter + plugin emit, not in application code,
 * and a graph reshuffle (chunk pinning, a dependency bump, a new route) can
 * put a previously-latent bad pair onto the entry's synchronous path at any
 * time. Checking source can't see that; checking the emitted bundle can.
 *
 * THE SHAPE THIS KEYS OFF (quoted from a real build,
 * apps/viewer/dist/assets/LayersPanel-*.js):
 *
 *   A chunk the plugin wrapped exports its deferred-promise binding
 *   literally, unmangled, alongside its real exports:
 *
 *     export { v as LazStreamingSource, p as n, u as t, __tla };
 *
 *   A correctly-propagated static importer imports that binding under a
 *   collision-safe alias and folds it into its own wait:
 *
 *     import { Zt as _, n as v, rn as y, __tla as __tla_0 } from "./store-*.js";
 *     ...
 *     let __tla = Promise.all([
 *         (()=>{ try { return __tla_0; } catch  {} })(),
 *         ...
 *     ]).then(async ()=>{ ... });
 *
 *   The literal export name `__tla` and the literal `__tla as __tla_N` (or
 *   bare `__tla`) import specifier are the plugin's structural fingerprint.
 *   They survive minification of every OTHER identifier because the plugin
 *   injects them as literal text after the rest of the pipeline has already
 *   mangled everything else -- so keying off `__tla` itself, rather than any
 *   source-level name, stays valid regardless of splitter/mangler behavior.
 *
 * A violation is: some chunk B has `import { ... } from "./A.js"` (a STATIC
 * import; dynamic `import()` is out of scope -- the plugin already appends
 * `.then(async m => { await m.__tla; return m; })` to every dynamic import
 * of a `__tla` chunk, so that shape is safe by construction), A exports
 * `__tla`, and B's import clause does not also import `__tla` (bare or
 * aliased) from A. Whether the bindings B imports are actually read at
 * module-evaluation time (vs. inside a function called later) is NOT
 * checked: the bundle-wide scan behind issue #2246 found 24 such
 * chunk-pairs and only ONE sat on the entry's synchronous path today --
 * checking only "on the sync path today" is exactly the gate that stays
 * green until the next chunk reshuffle moves a latent pair onto that path.
 *
 * The check also refuses to report success when it had nothing to inspect: a
 * missing assets directory, a directory with no `.js` chunks, and chunks
 * among which not one is `__tla`-wrapped each exit 1. In all three every scan
 * below runs over an empty set, so "0 violations" would mean "0 chunks
 * examined". Its own behaviour is pinned by check-tla-chunk-await.test.mjs.
 *
 * Run via `pnpm check:tla-chunk-await` (wired into the viewer-e2e CI job,
 * right after the viewer build it inspects). Requires a built viewer
 * (`pnpm turbo build --filter=@ifc-lite/viewer`).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// `--root <dir>` points the check at an alternative repo root, matching the
// convention the other gate scripts use so their companion tests can drive
// them over a synthetic tree (see check-collab-room-model-target.mjs). CI and
// `pnpm check:tla-chunk-await` pass no argument and get the real repo.
const rootArgIndex = process.argv.indexOf('--root');
const ROOT =
  rootArgIndex !== -1 && process.argv[rootArgIndex + 1]
    ? process.argv[rootArgIndex + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_DIR = join(ROOT, 'apps', 'viewer', 'dist', 'assets');

if (!existsSync(ASSETS_DIR)) {
  console.error(
    `❌ ${relative(ROOT, ASSETS_DIR)} does not exist. This check inspects the ` +
      `EMITTED bundle, not source -- build the viewer first:\n\n` +
      `    pnpm turbo build --filter=@ifc-lite/viewer\n`,
  );
  process.exit(1);
}

const files = readdirSync(ASSETS_DIR).filter((f) => f.endsWith('.js'));

if (files.length === 0) {
  console.error(
    `❌ ${relative(ROOT, ASSETS_DIR)} exists but contains no .js chunks -- this is\n` +
      `not a clean build, it is an INTERRUPTED or misconfigured one. Nothing was\n` +
      `inspected: an empty chunk list is not the same as zero violations, and\n` +
      `reporting "0 chunks checked" as success would silently stop guarding the\n` +
      `moment the build tool changes where it emits chunks. Rebuild the viewer:\n\n` +
      `    pnpm turbo build --filter=@ifc-lite/viewer\n`,
  );
  process.exit(1);
}

/** entry: "name" | "local as exported" -> the EXPORTED (public) name. */
function exportedNameOf(entry) {
  const m = entry.trim().match(/^([\w$]+)\s+as\s+(['"]?)([\w$]+)\2$/);
  if (m) return m[3];
  const bare = entry.trim().match(/^([\w$]+)$/);
  return bare ? bare[1] : null;
}

/** entry: "name" | "imported as local" -> the IMPORTED (external) name. */
function importedNameOf(entry) {
  const m = entry.trim().match(/^([\w$]+)\s+as\s+([\w$]+)$/);
  if (m) return m[1];
  const bare = entry.trim().match(/^([\w$]+)$/);
  return bare ? bare[1] : null;
}

const sources = new Map(); // filename -> file text
const tlaExporters = new Set(); // filenames that export a literal `__tla`

for (const file of files) {
  const text = readFileSync(join(ASSETS_DIR, file), 'utf8');
  sources.set(file, text);
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    const entries = m[1].split(',').map((e) => e.trim()).filter(Boolean);
    if (entries.some((e) => exportedNameOf(e) === '__tla')) {
      tlaExporters.add(file);
      break;
    }
  }
}

// A build that emitted chunks but not one `__tla`-wrapped chunk has not been
// checked -- it has been walked past. Every loop below is keyed off
// `tlaExporters`, so with the set empty they iterate over nothing and
// `violations` is empty because nothing was examined, not because nothing was
// wrong. That is the same vacuous pass the empty-`files` guard above closes,
// one level deeper, and the old success line advertised it in its own numbers
// (`0 static import(s) ... (0 __tla-wrapped chunk(s) among 2 emitted
// chunk(s))`) while exiting 0.
//
// Zero wrapped chunks is not a state a healthy viewer build reaches.
// `vite-plugin-top-level-await` is registered for both the app build and the
// worker build (apps/viewer/vite.config.ts), and it wraps every chunk it
// flags for transformation -- which includes any chunk containing a dynamic
// `import()`, of which this code-split app emits many. So an empty set means
// the plugin is gone or renamed, its `__tla` fingerprint changed shape, or the
// build now emits its chunks somewhere this check does not look. In all three
// the check is inert, and an inert gate must say so rather than tick.
//
// Deliberately NOT extended to `staticTlaImports === 0`: a `__tla`-wrapped
// chunk that is only ever `import()`ed dynamically is a perfectly ordinary
// lazy route, and the plugin makes that shape safe by construction.
if (tlaExporters.size === 0) {
  console.error(
    `❌ ${relative(ROOT, ASSETS_DIR)} has ${files.length} .js chunk(s) but NOT ONE of\n` +
      `them exports a \`__tla\` binding, so this check examined nothing. Zero\n` +
      `violations here means zero chunks inspected, not a clean bundle -- every\n` +
      `scan in this gate is keyed off the set of __tla-wrapped chunks, and that\n` +
      `set is empty.\n\n` +
      `A viewer build reaches this state only if something changed underneath the\n` +
      `check:\n\n` +
      `  * vite-plugin-top-level-await was removed from apps/viewer/vite.config.ts,\n` +
      `    or is no longer applied to the build that produced these chunks;\n` +
      `  * the plugin was upgraded and no longer emits the literal \`__tla\` export\n` +
      `    this check fingerprints (see the header of this file);\n` +
      `  * the build emits its chunks somewhere other than the directory above.\n\n` +
      `If the plugin was removed ON PURPOSE, this gate guards nothing any more:\n` +
      `delete it and its CI wiring in the same change rather than leaving it\n` +
      `green and inert. Otherwise restore the plugin, or update this check's\n` +
      `fingerprint to whatever the new plugin version emits, and re-run:\n\n` +
      `    pnpm turbo build --filter=@ifc-lite/viewer\n`,
  );
  process.exit(1);
}

const violations = [];
const sideEffectViolations = [];
let staticTlaImports = 0;
let sideEffectImports = 0;

for (const [file, text] of sources) {
  // NOT anchored to line start/end: most chunks are esbuild pretty-printed
  // with one statement per line, but smaller chunks (observed: `pending-*`,
  // a Radix primitive chunk) are emitted as a single unbroken line with every
  // import concatenated before the first statement. A `^...$` anchored regex
  // silently matches zero imports in that shape -- which is exactly how the
  // first version of this check passed cleanly against a bundle reproducing
  // the real #2246 crash (`pending-*.js` imports `z as C` from a __tla chunk
  // and calls `C()` at module scope with no `__tla` in its import clause).
  // Matching the pattern anywhere in the text, independent of surrounding
  // whitespace, is what makes this check hold regardless of how the printer
  // formats a given chunk.
  //
  // Namespace (`import * as x from`) and combined default+named import
  // forms do not occur in this build's output (verified against a real
  // bundle); if the splitter ever starts emitting them this loop will
  // simply not match that import and the chunk-pair would go unchecked, so a
  // sanity count of tla-chunk imports below (`staticTlaImports`) failing to
  // rise across a build is the signal that assumption broke.
  const importRe = /import\s*\{([^}]*)\}\s*from\s*["']\.\/([^"']+\.js)["'];?/g;
  for (const m of text.matchAll(importRe)) {
    const [, clause, importedFile] = m;
    if (!tlaExporters.has(importedFile)) continue;
    staticTlaImports++;
    const entries = clause.split(',').map((e) => e.trim()).filter(Boolean);
    const awaitsTla = entries.some((e) => importedNameOf(e) === '__tla');
    if (awaitsTla) continue;
    const bindings = entries.map((e) => importedNameOf(e) ?? e).join(', ');
    violations.push({ importer: file, imported: importedFile, bindings });
  }

  // Bare side-effect imports (`import"./x.js"`, no clause and no `from`).
  // 5 exist in the current bundle; none target a __tla-wrapped chunk today,
  // so this matches nothing right now -- which is the point. A side-effect
  // import binds nothing, so it cannot produce the unassigned-var TypeError
  // the check above exists for. It fails differently: the imported chunk's
  // BODY is what got deferred into `__tla`, so its side effect simply has
  // not happened when the importer continues. For a chunk imported purely
  // for its side effect that is the whole contract -- `modulepreload-
  // polyfill` is one of the five, and a polyfill that installs later than
  // its importer expects is a real defect, just a quieter one than a white
  // screen. Counted separately and reported under its own heading so the
  // two failure modes are never conflated.
  const sideEffectRe = /import\s*["']\.\/([^"']+\.js)["']/g;
  for (const m of text.matchAll(sideEffectRe)) {
    const importedFile = m[1];
    sideEffectImports++;
    if (!tlaExporters.has(importedFile)) continue;
    sideEffectViolations.push({ importer: file, imported: importedFile });
  }
}

if (violations.length > 0) {
  console.error(
    `❌ ${violations.length} chunk(s) statically import a __tla-wrapped chunk without ` +
      `awaiting its __tla promise:\n`,
  );
  for (const v of violations) {
    console.error(
      `   ${v.importer}  imports { ${v.bindings} }  from  ${v.imported}  ` +
        `(exports __tla) without importing __tla itself`,
    );
  }
  console.error(`
${fixHint()}`);
}

if (sideEffectViolations.length > 0) {
  console.error(
    `\n❌ ${sideEffectViolations.length} chunk(s) import a __tla-wrapped chunk for its ` +
      `side effect only:\n`,
  );
  for (const v of sideEffectViolations) {
    console.error(`   ${v.importer}  imports  "./${v.imported}"  (exports __tla)`);
  }
  console.error(
    `\nA bare side-effect import binds nothing, so this does NOT throw the\n` +
      `TypeError above -- it fails more quietly. The imported chunk's body is\n` +
      `what got deferred into __tla, so its side effect has not run when the\n` +
      `importing chunk continues. For a chunk imported purely for its side\n` +
      `effect, that side effect IS the contract.\n`,
  );
}

if (violations.length > 0 || sideEffectViolations.length > 0) {
  process.exit(1);
}

console.log(
  `✅ 0 chunks importing a __tla chunk without awaiting it, ` +
    `${staticTlaImports} static import(s) of a __tla-wrapped chunk checked ` +
    `(${tlaExporters.size} __tla-wrapped chunk(s) among ${files.length} emitted chunk(s)); ` +
    `${sideEffectImports} bare side-effect import(s) checked.`,
);

function fixHint() {
  return (
    `Every chunk that statically imports a __tla-wrapped chunk must also\n` +
    `import that chunk's __tla binding and await it before evaluating anything\n` +
    `that reads the imported bindings -- otherwise those bindings are still\n` +
    `unassigned when the importing chunk runs, and calling one throws a\n` +
    `TypeError during module evaluation (a white screen, no error boundary\n` +
    `catches it). This is an emitted-bundle defect, not a source defect: it\n` +
    `comes from vite-plugin-top-level-await@1.6.0 flagging a chunk for\n` +
    `transformation because it contains a dynamic import(), then failing to\n` +
    `propagate that requirement to every STATIC importer. See issue #2246.`
  );
}
