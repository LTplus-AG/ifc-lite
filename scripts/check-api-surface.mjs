#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Guard: the exported API surface of every published (non-private)
 * package in packages/* is snapshotted in scripts/api-surface.json.
 * An accidental export removal/rename used to ship silently — nothing
 * compared the built dist/*.d.ts surface against anything committed.
 *
 * Modes:
 *   node scripts/check-api-surface.mjs            # check (CI: node-tests job)
 *   node scripts/check-api-surface.mjs --update   # rewrite the snapshot
 *
 * Run via `pnpm check:api-surface` / `pnpm api-surface:update`.
 * Requires built declarations (`pnpm build`) — except @ifc-lite/wasm,
 * whose pkg/ifc-lite.d.ts is committed (wasm-free typecheck lane, #952).
 *
 * Uses the TypeScript checker so re-exports (`export * from`,
 * `export { X as Y }`, `export type { X }`) across declaration files —
 * including cross-package ones — resolve to the real exported names.
 *
 * Every key in a package's `exports` map that resolves to a declaration
 * file gets its own snapshot entry (e.g. "@ifc-lite/mcp/server"), so
 * public subpath surfaces are guarded too. Non-code subpaths (wasm
 * assets, "./package.json", glob patterns) are skipped.
 *
 * Value exports demoted to type-only (`export { Foo }` -> `export type
 * { Foo }` — a runtime API removal that TS erases) are serialized
 * distinctly as "Foo: class (type-only)" so the demotion fails the check.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { collectEntryPoints } from './lib/public-entrypoints.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_PATH = join(ROOT, 'scripts', 'api-surface.json');
const UPDATE = process.argv.includes('--update');

/** Follow an alias export to its target symbol (best effort). */
function resolveAlias(checker, symbol) {
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      return checker.getAliasedSymbol(symbol);
    } catch {
      /* unresolvable alias — fall back to the alias symbol itself */
    }
  }
  return symbol;
}

/**
 * True when the export only reaches consumers as a type (`export type
 * { X }`, or a re-export of an `import type` binding) and is therefore
 * erased at runtime. Checked on the UNRESOLVED alias: resolving first
 * would lose the type-only marker and make a value→type demotion (a
 * runtime API removal) serialize identically to the value export.
 */
function isTypeOnlyExport(checker, symbol) {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return false;
  try {
    // Checker-level: walks the whole alias chain, so transitive
    // `import type { X } …; export { X }` is caught too.
    if (checker.getTypeOnlyAliasDeclaration(symbol)) return true;
  } catch {
    /* fall through to the syntactic check */
  }
  for (const decl of symbol.declarations ?? []) {
    if (
      ts.isExportSpecifier(decl) &&
      (decl.isTypeOnly || decl.parent.parent.isTypeOnly)
    ) {
      return true;
    }
  }
  return false;
}

/** Stable kind label for an (alias-resolved) export symbol. */
function symbolKind(target) {
  const f = target.flags;
  // Fixed order so merged declarations (e.g. interface + const) print
  // deterministically.
  const labels = [];
  if (f & ts.SymbolFlags.Class) labels.push('class');
  if (f & ts.SymbolFlags.Function) labels.push('function');
  if (f & ts.SymbolFlags.Enum) labels.push('enum');
  if (f & ts.SymbolFlags.Variable) labels.push('const');
  if (f & ts.SymbolFlags.Interface) labels.push('interface');
  if (f & ts.SymbolFlags.TypeAlias) labels.push('type');
  if (f & ts.SymbolFlags.Module) labels.push('namespace');
  return labels.length > 0 ? labels.join('+') : 'unknown';
}

/** "Name: kind" line; value exports demoted to type-only get a marker. */
function exportLine(checker, symbol) {
  const target = resolveAlias(checker, symbol);
  const typeOnly =
    target.flags & ts.SymbolFlags.Value && isTypeOnlyExport(checker, symbol);
  return `${symbol.name}: ${symbolKind(target)}${typeOnly ? ' (type-only)' : ''}`;
}

/** entries: Map<surfaceKey, entryDtsPath> -> { surfaceKey: ["Name: kind", ...] } */
function extractSurface(entries) {
  const program = ts.createProgram([...entries.values()], {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const surface = {};
  for (const [surfaceKey, entryPath] of [...entries.entries()].sort()) {
    const sourceFile = program.getSourceFile(entryPath);
    if (!sourceFile) {
      throw new Error(`TypeScript program did not load ${entryPath}`);
    }
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    const exports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
    surface[surfaceKey] = exports.map((sym) => exportLine(checker, sym)).sort();
  }
  return surface;
}

function diffLists(before = [], after = []) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((e) => !beforeSet.has(e)),
    removed: before.filter((e) => !afterSet.has(e)),
  };
}

const { entries, missing, packageCount } = collectEntryPoints(ROOT);
if (missing.length > 0) {
  console.error('❌ Published packages whose declaration entry is missing:\n');
  for (const { name, entry } of missing) console.error(`   ${name}  (${entry})`);
  console.error('\nRun `pnpm build` first — the API surface is read from built d.ts files.');
  process.exit(1);
}

const surface = extractSurface(entries);
const serialized = `${JSON.stringify(surface, null, 2)}\n`;

if (UPDATE) {
  writeFileSync(SNAPSHOT_PATH, serialized);
  const total = Object.values(surface).reduce((n, list) => n + list.length, 0);
  console.log(
    `✅ Wrote scripts/api-surface.json (${packageCount} packages, ${Object.keys(surface).length} export surfaces, ${total} exports).`,
  );
  process.exit(0);
}

if (!existsSync(SNAPSHOT_PATH)) {
  console.error('❌ scripts/api-surface.json is missing. Run `pnpm api-surface:update` and commit it.');
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
const pkgNames = [...new Set([...Object.keys(snapshot), ...Object.keys(surface)])].sort();
let dirty = false;

for (const pkgName of pkgNames) {
  if (!(pkgName in surface)) {
    dirty = true;
    console.error(
      `\n${pkgName}: export surface no longer published (in snapshot, not in packages/* exports)`,
    );
    continue;
  }
  if (!(pkgName in snapshot)) {
    dirty = true;
    console.error(`\n${pkgName}: new published export surface (not in snapshot)`);
    for (const e of surface[pkgName]) console.error(`   + ${e}`);
    continue;
  }
  const { added, removed } = diffLists(snapshot[pkgName], surface[pkgName]);
  if (added.length === 0 && removed.length === 0) continue;
  dirty = true;
  console.error(`\n${pkgName}:`);
  for (const e of removed) console.error(`   - ${e}`);
  for (const e of added) console.error(`   + ${e}`);
}

if (dirty) {
  console.error(`
❌ Public API surface drifted from scripts/api-surface.json (see diff above).

If the change is intentional:
  1. pnpm api-surface:update   (rewrites the snapshot — commit it)
  2. pnpm changeset            (removed/renamed export = major on ≥1.0 pkgs, minor on 0.x)

If it is NOT intentional, restore the missing export — this guard exists
because accidental export removals used to ship silently.`);
  process.exit(1);
}

const total = Object.values(surface).reduce((n, list) => n + list.length, 0);
console.log(
  `✅ API surface matches snapshot (${packageCount} packages, ${Object.keys(surface).length} export surfaces, ${total} exports).`,
);
