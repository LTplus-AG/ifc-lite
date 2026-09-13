/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Split out of `server-browser-type-extractors.mjs` purely to stay under
 * the module-size budget (that file was already split once for #4672's own
 * fix — see its header). Holds the ONE thing `schemaDerivedHierarchyRelTypes`
 * needs beyond a plain `require(dist)`: an alternate loading path that lets
 * `check-server-browser-type-parity.test.mjs` prove a mutation to the REAL
 * schema walk (`getAllConcreteRelationshipTypes()` in
 * `packages/parser/src/relationship-schema-slots.ts`) is detectable by the
 * parity gate — a finding raised on #4672: the previous shape could only
 * ever exercise the still-literal sibling Sets (PROPERTY_REL_TYPES,
 * ASSOCIATION_REL_TYPES) by mutation, because `--root`-driven test fixtures
 * copy mutated SOURCE files, never a rebuilt `dist/`, and
 * `schemaDerivedHierarchyRelTypes` always read the REAL repo's `dist/`
 * regardless of `--root` (deliberately — see that function's doc comment).
 *
 * The two costs already ruled out for closing that gap were (a) rebuilding
 * `@ifc-lite/parser`'s `dist/` per test — `pnpm build` runs `tsc` over the
 * whole package, ~seconds, for what should be a millisecond regression
 * check — and (b) re-deriving the schema walk a second time under test,
 * which is exactly the logic duplication AGENTS.md's generator rules (and
 * this checker's own "don't re-derive HIERARCHY_REL_TYPES here" comment)
 * warn against.
 *
 * This is a third option: run the REAL, unmodified
 * `getAllConcreteRelationshipTypes()` straight off SOURCE, in a child
 * process started with Node's built-in `--experimental-strip-types` (no
 * bundler, no separate build tool, no new dependency). The only thing
 * standing between that flag and a working import is that
 * `relationship-schema-slots.ts` (like every `tsc`-built file in this repo)
 * imports its `generated/*` siblings by their EMITTED `.js` extension, which
 * doesn't exist next to unbuilt source — `ts-source-loader.mjs`'s resolve
 * hook is the one-line fix for exactly that, nothing more. Real production
 * runs of the checker never pass `sourcePath`, so this path is inert unless
 * a caller opts in.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOADER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'ts-source-loader.mjs');

/** Runs the given TS source file in a child process with type stripping and
 * the `.js`->`.ts` fallback resolver, returning its
 * `getAllConcreteRelationshipTypes()` result as a plain array — JSON is the
 * only channel out of a child process, and a `ReadonlySet<string>` of type
 * names round-trips through it losslessly. Throws with the child's stderr
 * on any failure (bad mutation, resolution failure, non-zero exit). */
function runFromSource(sourcePath) {
  const entry = `import(${JSON.stringify(pathToFileURL(sourcePath).href)}).then((m) => {
    process.stdout.write(JSON.stringify([...m.getAllConcreteRelationshipTypes()]));
  }).catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });`;
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--experimental-loader', LOADER_PATH, '--input-type=module', '--eval', entry],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`failed to import ${sourcePath} from TS source under --experimental-strip-types: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * Loads the `relationship-schema-slots` module. `sourcePath` (test-only —
 * the real checker never passes it) selects the direct-from-TS-source path
 * above instead of `require(distPath)`.
 */
export function loadHierarchySchemaModule({ distPath, sourcePath }) {
  if (!sourcePath) {
    const require = createRequire(import.meta.url);
    return require(distPath);
  }
  const types = runFromSource(sourcePath);
  return { getAllConcreteRelationshipTypes: () => new Set(types) };
}
