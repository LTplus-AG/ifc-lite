#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate `apps/viewer/src/lib/scripts/templates/bim-globals.d.ts` from
 * NAMESPACE_SCHEMAS.
 *
 * Single source of truth: `packages/sandbox/src/bridge-schema.ts` defines every
 * SDK method exposed to sandbox scripts. This script reads that schema and
 * emits the ambient TypeScript declarations for the `bim` global.
 *
 * The other two consumers of NAMESPACE_SCHEMAS read it live — the script
 * editor's completions (`CodeEditor.tsx`) and the LLM system prompt — so this
 * file is the only one that can drift, and it did: `bim.clash` was absent from
 * the moment the namespace landed (#891, 2026-05-31) until #2418, and two
 * `create` signatures had been missing a parameter since #598 (2026-04-29).
 * Nothing regenerated it because the generator did not run (see below), so the
 * file was instead hand-edited — #1152 edited a file marked AUTO-GENERATED
 * while the schema already had both. Hence the `--check` gate.
 *
 * Reads the BUILT sandbox bundle, not the TypeScript source, for the same
 * reason `generate-server-attr-indices.mjs` does: an absolute-path import of
 * `dist/index.js` runs on plain node with no loader and no tsconfig `paths`
 * rewriting in the middle of the import graph.
 *
 * Two things the schema names rather than spells out are EXTRACTED from their
 * defining sources here (see `derivedTypeLines` and DERIVED_TYPE_SOURCES):
 * the `BimClash.*` clash-engine types, and the sandbox `console`. Transcribing
 * either into this file would put a hand-maintained copy of another package's
 * types in the one script whose whole purpose is to stop such copies rotting
 * (#2422). Because both are derived, a change upstream turns the `--check`
 * gate red exactly as a schema change does.
 *
 * Modes (mirrors scripts/generate-server-attr-indices.mjs UX):
 *   node scripts/generate-bim-globals.mjs           # rewrite  (pnpm generate:bim-globals)
 *   node scripts/generate-bim-globals.mjs --check   # verify, diff + exit 1 if stale
 *
 * The build the import needs comes from `pnpm generate:bim-globals` /
 * `pnpm check:bim-globals`; CI runs the bare `--check` after restoring the
 * build artifact.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const CHECK = process.argv.includes('--check');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH = join(ROOT, 'apps/viewer/src/lib/scripts/templates/bim-globals.d.ts');

// `import()` of a bare absolute path throws ERR_UNSUPPORTED_ESM_URL_SCHEME on
// Windows, where the path starts with a drive letter that Node reads as a URL
// scheme ("c:"). AGENTS.md supports Windows-without-WSL as a dev path (it is
// why `build:wasm:fetch` exists), so go through a file:// URL.
const { NAMESPACE_SCHEMAS, SANDBOX_CONSOLE_LEVELS } = await import(
  pathToFileURL(join(ROOT, 'packages/sandbox/dist/index.js')).href
);

// A stale or half-built dist can import cleanly and still export nothing. In
// write mode that would exit 0 having replaced the whole type surface with a
// bare header, so refuse to emit rather than trust an empty schema.
if (!Array.isArray(NAMESPACE_SCHEMAS) || NAMESPACE_SCHEMAS.length === 0) {
  console.error(
    '❌ NAMESPACE_SCHEMAS is missing or empty in packages/sandbox/dist/index.js — ' +
      'stale or broken build; refusing to emit an empty bim-globals.d.ts.\n' +
      '   Rebuild with `pnpm turbo build --filter=@ifc-lite/sandbox` and retry.',
  );
  process.exit(1);
}

if (!Array.isArray(SANDBOX_CONSOLE_LEVELS) || SANDBOX_CONSOLE_LEVELS.length === 0) {
  console.error(
    '❌ SANDBOX_CONSOLE_LEVELS is missing or empty in packages/sandbox/dist/index.js — ' +
      'stale or broken build; refusing to emit a bim-globals.d.ts with no `console`.\n' +
      '   Rebuild with `pnpm turbo build --filter=@ifc-lite/sandbox` and retry.',
  );
  process.exit(1);
}

// ── Derived type declarations ─────────────────────────────────────────────
//
// Some `tsReturn` / `tsParamTypes` values name real engine types rather than
// spelling a shape inline (`Promise<BimClash.ClashResult>`). Those declarations
// are EXTRACTED from the defining sources below, never transcribed here: a
// hand-written copy of `packages/clash`'s types in this file would be a fresh
// ungated drift surface, in a generator that exists because an ungated surface
// rotted (#2418, #2422).
//
// Emitted inside `declare namespace BimClash` so that (a) cross-references
// between the extracted declarations resolve verbatim, with no identifier
// rewriting, and (b) exactly one name enters the ambient global scope —
// `Clash`, `Vec3` and `AABB` at top level would collide with a script author's
// own declarations.

/** Sources searched for extracted declarations, in resolution order. */
const DERIVED_TYPE_SOURCES = [
  'packages/clash/src/types.ts',
  'packages/clash/src/disciplines.ts',
  'packages/spatial/src/aabb.ts',
];

/**
 * Roots of the extraction. Everything these reach, transitively, is emitted;
 * anything they reach that is NOT in DERIVED_TYPE_SOURCES is a hard error, so
 * a field added upstream can never be silently dropped from the declaration.
 */
const DERIVED_TYPE_ROOTS = ['ClashResult', 'ClashGroup', 'ClashRule', 'ClashRulePreset'];

/**
 * Type names that resolve without a declaration of ours: TypeScript keywords
 * and the `lib` globals the templates tsconfig loads (ES2022, no DOM).
 */
const AMBIENT_TYPE_NAMES = new Set([
  'Array', 'ReadonlyArray', 'Record', 'Readonly', 'Partial', 'Required', 'Pick',
  'Omit', 'Exclude', 'Extract', 'NonNullable', 'Map', 'ReadonlyMap', 'Set',
  'ReadonlySet', 'Promise', 'Date', 'RegExp', 'Error', 'Function', 'Object',
]);

/**
 * Collect top-level `interface` / `type` declarations from the source files,
 * keyed by name. Later files do not override earlier ones — a duplicate name
 * across sources is ambiguous, so it is refused rather than silently resolved.
 */
function collectDeclarations() {
  const byName = new Map();
  for (const rel of DERIVED_TYPE_SOURCES) {
    const path = join(ROOT, rel);
    const text = readFileSync(path, 'utf-8');
    const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
    for (const statement of sourceFile.statements) {
      if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue;
      const name = statement.name.text;
      const existing = byName.get(name);
      if (existing && existing.source !== rel) {
        console.error(
          `❌ Type '${name}' is declared in both ${existing.source} and ${rel}. ` +
            'DERIVED_TYPE_SOURCES must resolve every name unambiguously.',
        );
        process.exit(1);
      }
      byName.set(name, { node: statement, sourceFile, source: rel });
    }
  }
  return byName;
}

/** Every identifier used in a type position inside `node`. */
function referencedTypeNames(node) {
  const names = new Set();
  const visit = n => {
    if (ts.isTypeReferenceNode(n)) {
      // Only the leftmost identifier of a qualified name matters; the extracted
      // sources use none, but a `ns.Type` must not be read as `Type`.
      const root = ts.isQualifiedName(n.typeName) ? undefined : n.typeName.text;
      if (root) names.add(root);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return names;
}

/**
 * The declaration's own text plus its JSDoc.
 *
 * `getFullText()` would drag in every preceding comment — for the first
 * declaration in a file that includes the MPL licence header — so take only the
 * LAST leading comment block, and only when it is JSDoc.
 */
function declarationText(entry) {
  const { node, sourceFile } = entry;
  const full = sourceFile.getFullText();
  const body = node.getText(sourceFile);
  const ranges = ts.getLeadingCommentRanges(full, node.getFullStart()) ?? [];
  const last = ranges[ranges.length - 1];
  if (!last) return body;
  const comment = full.slice(last.pos, last.end);
  if (!comment.startsWith('/**')) return body;
  return `${comment}\n${body}`;
}

/**
 * Emit the transitive closure of DERIVED_TYPE_ROOTS as a `declare namespace`
 * body. Roots come first, in declared order, then dependencies in discovery
 * order — deterministic, which the `--check` gate depends on.
 */
function derivedTypeLines() {
  const declarations = collectDeclarations();
  const emitted = [];
  const seen = new Set();
  const queue = [...DERIVED_TYPE_ROOTS];

  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = declarations.get(name);
    if (!entry) {
      console.error(
        `❌ Cannot extract type '${name}': it is referenced by the sandbox bim type surface ` +
          `but declared in none of:\n${DERIVED_TYPE_SOURCES.map(s => `     ${s}`).join('\n')}\n` +
          '   Add the file that declares it to DERIVED_TYPE_SOURCES in scripts/generate-bim-globals.mjs.',
      );
      process.exit(1);
    }
    emitted.push(entry);
    for (const ref of referencedTypeNames(entry.node)) {
      if (AMBIENT_TYPE_NAMES.has(ref) || seen.has(ref)) continue;
      queue.push(ref);
    }
  }

  const lines = [
    '// ── Clash engine types ──────────────────────────────────────────────────',
    '//',
    '// Extracted by the generator from the sources below — these declarations are',
    '// the engine\'s own text, not a copy maintained in the generator:',
    ...DERIVED_TYPE_SOURCES.map(source => `//   ${source}`),
    '',
    'declare namespace BimClash {',
  ];
  for (const entry of emitted) {
    for (const line of declarationText(entry).split('\n')) {
      lines.push(line === '' ? '' : `  ${line}`);
    }
    lines.push('');
  }
  // Drop the trailing blank line before the closing brace.
  lines.pop();
  lines.push('}');
  return lines;
}

/** Map an ArgType to a TypeScript type string */
function argTypeToTS(argType) {
  switch (argType) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'dump': return 'unknown';
    case 'entityRefs': return 'BimEntity[]';
    case '...strings': return '...types: string[]';
    default: return 'unknown';
  }
}

/**
 * Strip a trailing ` | undefined` from a type string and flag the parameter
 * as optional — emits `name?: type` instead of the noisier `name: type | undefined`.
 */
function normalizeOptional(tsType) {
  const match = tsType.match(/^(.*?)\s*\|\s*undefined\s*$/);
  if (match) return { type: match[1].trim(), optional: true };
  return { type: tsType, optional: false };
}

/** Generate a TypeScript method signature from a MethodSchema */
function methodSignature(m) {
  const params = [];

  for (let i = 0; i < m.args.length; i++) {
    const argType = m.args[i];
    const overrideType = m.tsParamTypes?.[i];
    if (argType === '...strings') {
      const name = m.paramNames?.[i] ?? 'args';
      params.push(`...${name}: string[]`);
    } else {
      const name = m.paramNames?.[i] ?? `arg${i}`;
      const rawType = overrideType ?? argTypeToTS(argType);
      const { type, optional } = normalizeOptional(rawType);
      params.push(`${name}${optional ? '?' : ''}: ${type}`);
    }
  }

  // Determine return type
  let returnType;
  if (m.tsReturn) {
    returnType = m.tsReturn;
  } else if (m.returns === 'void') {
    returnType = 'void';
  } else if (m.returns === 'string') {
    returnType = 'string';
  } else {
    returnType = 'unknown';
  }

  return `    /** ${m.doc} */\n    ${m.name}(${params.join(', ')}): ${returnType};`;
}

// ── Generate ──────────────────────────────────────────────────────────────

const lines = [
  '/* This Source Code Form is subject to the terms of the Mozilla Public',
  ' * License, v. 2.0. If a copy of the MPL was not distributed with this',
  ' * file, You can obtain one at https://mozilla.org/MPL/2.0/. */',
  '',
  '/**',
  ' * AUTO-GENERATED — do not edit by hand.',
  ' * Run: pnpm generate:bim-globals',
  ' *',
  ' * Type declarations for the sandbox `bim` global.',
  ' * Generated from NAMESPACE_SCHEMAS in bridge-schema.ts.',
  ' */',
  '',
  '// ── Entity types ────────────────────────────────────────────────────────',
  '',
  'interface BimEntity {',
  '  ref: { modelId: string; expressId: number };',
  '  name: string; Name: string;',
  '  type: string; Type: string;',
  '  globalId: string; GlobalId: string;',
  '  description: string; Description: string;',
  '  objectType: string; ObjectType: string;',
  '}',
  '',
  'interface BimPropertySet {',
  '  name: string;',
  '  properties: Array<{ name: string; value: string | number | boolean | null }>;',
  '}',
  '',
  'interface BimQuantitySet {',
  '  name: string;',
  '  quantities: Array<{ name: string; value: number | null }>;',
  '}',
  '',
  'interface BimAttribute {',
  '  name: string;',
  '  value: string;',
  '}',
  '',
  'interface BimClassification {',
  '  system?: string;',
  '  identification?: string;',
  '  name?: string;',
  '  location?: string;',
  '  description?: string;',
  '  path?: string[];',
  '}',
  '',
  'interface BimMaterialLayer {',
  '  materialName?: string;',
  '  thickness?: number;',
  '  isVentilated?: boolean;',
  '  name?: string;',
  '  category?: string;',
  '}',
  '',
  'interface BimMaterialProfile {',
  '  materialName?: string;',
  '  name?: string;',
  '  category?: string;',
  '}',
  '',
  'interface BimMaterialConstituent {',
  '  materialName?: string;',
  '  name?: string;',
  '  fraction?: number;',
  '  category?: string;',
  '}',
  '',
  'interface BimMaterial {',
  '  type: \'Material\' | \'MaterialLayerSet\' | \'MaterialProfileSet\' | \'MaterialConstituentSet\' | \'MaterialList\';',
  '  name?: string;',
  '  description?: string;',
  '  layers?: BimMaterialLayer[];',
  '  profiles?: BimMaterialProfile[];',
  '  constituents?: BimMaterialConstituent[];',
  '  materials?: string[];',
  '}',
  '',
  'interface BimTypeProperties {',
  '  typeName: string;',
  '  typeId: number;',
  '  properties: BimPropertySet[];',
  '}',
  '',
  'interface BimDocument {',
  '  name?: string;',
  '  description?: string;',
  '  location?: string;',
  '  identification?: string;',
  '  purpose?: string;',
  '  intendedUse?: string;',
  '  revision?: string;',
  '  confidentiality?: string;',
  '}',
  '',
  'interface BimRelationships {',
  '  voids: Array<{ id: number; name?: string; type: string }>;',
  '  fills: Array<{ id: number; name?: string; type: string }>;',
  '  groups: Array<{ id: number; name?: string }>;',
  '  connections: Array<{ id: number; name?: string; type: string }>;',
  '}',
  '',
  'interface BimModelInfo {',
  '  id: string;',
  '  name: string;',
  '  schemaVersion: string;',
  '  entityCount: number;',
  '  fileSize: number;',
  '}',
  '',
  'interface BimFileAttachment {',
  '  name: string;',
  '  type: string;',
  '  size: number;',
  '  rowCount?: number;',
  '  columns?: string[];',
  '  hasTextContent: boolean;',
  '}',
  '',
  ...derivedTypeLines(),
  '',
  '// ── Sandbox globals ─────────────────────────────────────────────────────',
  '',
  '/**',
  ' * The sandbox `console`. Output is captured into the run result, not written',
  ' * to the host console.',
  ' *',
  ' * These are the only methods QuickJS is given; there is no `console.table`,',
  ' * and no `document`, `window` or `fetch` global at all.',
  ' */',
  'declare const console: {',
  ...SANDBOX_CONSOLE_LEVELS.map(level => `  ${level}(...args: unknown[]): void;`),
  '};',
  '',
  '// ── Namespace declarations ──────────────────────────────────────────────',
  '',
  'declare const bim: {',
];

for (const ns of NAMESPACE_SCHEMAS) {
  lines.push(`  /** ${ns.doc} */`);
  lines.push(`  ${ns.name}: {`);
  for (const method of ns.methods) {
    lines.push(methodSignature(method));
  }
  lines.push('  };');
}

lines.push('};');
lines.push('');

const content = lines.join('\n');
const relOut = relative(ROOT, OUTPUT_PATH);

if (!CHECK) {
  writeFileSync(OUTPUT_PATH, content, 'utf-8');
  console.log(`✅ Generated ${relOut} (${NAMESPACE_SCHEMAS.length} namespaces).`);
  process.exit(0);
}

const committed = readFileSync(OUTPUT_PATH, 'utf-8');
if (committed === content) {
  console.log(`✅ ${relOut} is in sync with NAMESPACE_SCHEMAS (${NAMESPACE_SCHEMAS.length} namespaces).`);
  process.exit(0);
}

console.error(`\n❌ ${relOut} is out of date with NAMESPACE_SCHEMAS:\n`);
printDiff(committed, content);
console.error('\nRun `pnpm generate:bim-globals` and commit the result.\n');
process.exit(1);

/** Line diff (committed vs freshly generated), for --check output. */
function printDiff(before, after) {
  const b = before.split('\n');
  const a = after.split('\n');
  const max = Math.max(b.length, a.length);
  let shown = 0;
  for (let i = 0; i < max; i += 1) {
    if (b[i] === a[i]) continue;
    if (shown >= 40) {
      console.error('   … (diff truncated)');
      return;
    }
    if (b[i] !== undefined) console.error(`   - ${b[i]}`);
    if (a[i] !== undefined) console.error(`   + ${a[i]}`);
    shown += 1;
  }
}
