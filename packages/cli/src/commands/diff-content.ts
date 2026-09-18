/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite diff --by-content` — the engine-backed half of the diff command
 * (issue #1891), plus the identity-map sidecar it can emit and consume.
 *
 * The loop this closes: run it once, review the `renamed` matches, keep the
 * sidecar. On the next run the accepted claims come back in as key aliases, the
 * re-GUIDed elements are matched by key, and they never show up as churn again.
 * Data scope by default — see `diff-engine.ts`; `--geometry` below opts into
 * the wasm mesh pass.
 *
 * Issue #4955 adds three things on the same loop: `--key-from` keys the
 * comparison on an authored identifier instead of GlobalId; `--lineage-out` /
 * `--lineage-in` write and replay the 1:k lineage an external table rekeys on;
 * and `--accept` folds a reviewed identity map (a human's answer to the
 * suggestions a geometry-capable run produced) into that lineage as
 * `replaced` entries.
 *
 * Issue #4956 adds `--geometry`: a lazily-loaded `@ifc-lite/wasm` mesh pass
 * (`diff-geometry.ts`) that attaches world geometry hashes, bounding boxes and
 * volumes to both files' fingerprints, promoting the scope from `data` to
 * `both`. `--split-merge` / `--successors` turn on the two geometry-only
 * detection stages; both are no-ops without `--geometry` (the engine abstains
 * exactly as it does for a viewer session whose geometry hashing failed).
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Stats } from 'node:fs';
import {
  createIdentityMapSidecar,
  createLineageSidecar,
  diffModels,
  identityMapFromContentMatches,
  identityMapSidecarMismatches,
  keyAliasesFromLineage,
  keyAliasesFromSidecar,
  parseIdentityMapSidecar,
  serializeIdentityMapSidecar,
  serializeLineageSidecar,
  type ContentMatch,
  type IdentityMapEntry,
  type IdentityMapSidecar,
  type LineageEntry,
  type ModelIdentity,
} from '@ifc-lite/diff';
import { parseAuthoredKeySpec } from '@ifc-lite/parser';
import { loadIfcBytes } from '../loader.js';
import { fatal, printJson } from '../output.js';
import { buildFileFingerprints, modelIdentityOf, type DiffRef } from './diff-engine.js';
import { resolveGeometryScope } from './diff-geometry.js';
import { mergeAliases, mergeLineage, readVerifiedLineage } from './diff-lineage-io.js';
import { printReport } from './diff-content-report.js';

export interface ContentDiffOptions {
  basePath: string;
  headPath: string;
  /** `--identity-in`: a sidecar to replay as key aliases. */
  identityIn?: string;
  /** `--identity-out`: where to write the sidecar this run establishes. */
  identityOut?: string;
  /** `--lineage-in`: a lineage whose 1:1 entries are replayed as key aliases. */
  lineageIn?: string;
  /** `--lineage-out`: where to write the lineage this run establishes. */
  lineageOut?: string;
  /** `--accept`: a reviewed identity map folded into the lineage as `replaced`. */
  accept?: string;
  /** `--key-from`: `Tag` or `Pset.Prop`, the authored key to compare on. */
  keyFrom?: string;
  /** `--geometry`: run the wasm mesh pass and attach world geometry hashes,
   *  boxes and volumes, promoting the comparison from `data` to `both`
   *  scope (issue #4956). Skips with a stderr warning, not a fatal error,
   *  when the wasm runtime is not built on this host. */
  geometry?: boolean;
  /** `--split-merge`: opt in to the split/merge detector. Only produces
   *  claims together with `--geometry` (issue #4956). */
  splitMerge?: boolean;
  /** `--successors`: opt in to the successor-match detector. Only produces
   *  claims together with `--geometry` (issue #4956). */
  successors?: boolean;
  json: boolean;
}

export async function contentDiffCommand(options: ContentDiffOptions): Promise<void> {
  const { basePath, headPath } = options;
  if (options.keyFrom !== undefined && !parseAuthoredKeySpec(options.keyFrom)) {
    fatal(`--key-from must be Tag or <PsetName>.<PropertyName>, got "${options.keyFrom}"`);
  }
  const keyProperty = options.keyFrom?.trim();

  // Before anything is read, and long before anything is written.
  await refuseOverwritingAnInput(options);

  const baseBytes = await readModel(basePath);
  const headBytes = await readModel(headPath);
  const baseIdentity = modelIdentityOf(basePath, baseBytes);
  const headIdentity = modelIdentityOf(headPath, headBytes);

  const pinned = { base: baseIdentity, head: headIdentity, keyProperty };
  const incoming = options.identityIn
    ? await readVerifiedSidecar(options.identityIn, pinned)
    : undefined;
  const incomingLineage = options.lineageIn
    ? await readVerifiedLineage(options.lineageIn, pinned)
    : undefined;
  const accepted = options.accept ? await readVerifiedSidecar(options.accept, pinned) : undefined;

  process.stderr.write('Loading files...\n');
  const baseStore = await loadIfcBytes(baseBytes, basePath);
  const headStore = await loadIfcBytes(headBytes, headPath);

  const duplicateAuthoredKeys = new Map<string, number[]>();
  const adapter = { keyProperty, duplicateAuthoredKeys };
  const baseFingerprints = buildFileFingerprints(baseStore, adapter);
  const headFingerprints = buildFileFingerprints(headStore, adapter);
  for (const [value, ids] of duplicateAuthoredKeys) {
    process.stderr.write(
      `Warning: ${keyProperty} = "${value}" names ${ids.length} entities; they fall back to GlobalId.\n`,
    );
  }

  // Both sources of aliases are replayed together. A lineage's 1:1 entries and
  // an identity map's claims are the same kind of thing under two file formats;
  // where the two disagree about one head key, neither is applied — that is
  // `resolveKeyAliases` rule 4, arriving from two files instead of one.
  const aliases = mergeAliases(
    incoming ? keyAliasesFromSidecar(incoming) : undefined,
    incomingLineage ? keyAliasesFromLineage(incomingLineage.entries) : undefined,
  );

  // `--geometry` (issue #4956): see `diff-geometry.ts` for the wasm pass and
  // the graceful fall-back to `scope: 'data'` when the runtime is absent.
  const scope = await resolveGeometryScope(
    options.geometry ?? false,
    baseBytes,
    headBytes,
    baseFingerprints,
    headFingerprints,
    (message) => process.stderr.write(`Warning: ${message}\n`),
  );

  const diff = diffModels(baseFingerprints, headFingerprints, {
    scope,
    matchUnpairedByContent: true,
    keyAliases: aliases,
    // Both are geometry-only stages (issue #4956): with no geometry pass run,
    // the engine abstains and `diff.splitMerges` / `diff.successors` stay
    // undefined, exactly as a viewer session with failed geometry hashing.
    detectSplitMerge: options.splitMerge,
    detectSuccessors: options.successors,
  });

  const applied = diff.appliedKeyAliases ?? new Map<string, string>();
  const ignored = aliases ? aliases.size - applied.size : 0;

  let written: { path: string; entries: IdentityMapEntry[] } | undefined;
  if (options.identityOut) {
    const entries = mergeIdentityClaims(incoming, applied, diff.contentMatches);
    const sidecar = createIdentityMapSidecar({
      base: baseIdentity,
      head: headIdentity,
      entries,
      // Reproducible by construction: identical inputs write identical bytes.
      // The builder sorts and de-duplicates so a checked-in sidecar produces an
      // empty git diff when nothing changed, and stamping `Date.now()` here
      // would throw that away — every rerun, including the
      // `--identity-in x --identity-out x` carry-forward, would show a one-line
      // diff that says nothing about the claims. An incoming `created` is
      // preserved instead of refreshed: it dates the claims, not the rewrite,
      // and the sidecar is addressed by the two model digests either way. There
      // is deliberately no flag to request a fresh stamp — it would add CLI
      // surface for a field the format already documents as informational and
      // optional, and `git log` dates a reviewed, committed artifact better
      // than a self-reported timestamp does.
      created: incoming?.created,
      keyProperty,
    });
    await writeFile(options.identityOut, serializeIdentityMapSidecar(sidecar), 'utf-8');
    written = { path: options.identityOut, entries: sidecar.entries };
  }

  let lineageWritten: { path: string; entries: LineageEntry[] } | undefined;
  if (options.lineageOut) {
    const { entries, deleted } = mergeLineage(incomingLineage, incoming, diff, accepted);
    const sidecar = createLineageSidecar({
      base: baseIdentity,
      head: headIdentity,
      entries,
      deleted,
      created: incomingLineage?.created,
      keyProperty,
    });
    await writeFile(options.lineageOut, serializeLineageSidecar(sidecar), 'utf-8');
    lineageWritten = { path: options.lineageOut, entries: sidecar.entries };
  }

  if (options.json) {
    printJson({
      base: { path: basePath, hash: baseIdentity.hash, schema: baseStore.schemaVersion },
      head: { path: headPath, hash: headIdentity.hash, schema: headStore.schemaVersion },
      scope: diff.scope,
      counts: diff.counts,
      contentMatches: (diff.contentMatches ?? []).map((match) => ({
        kind: match.kind,
        base: match.base.map((entity) => entity.key),
        head: match.head.map((entity) => entity.key),
      })),
      // Absent (not `[]`) exactly when the stage did not run or the geometry
      // abstention fired — the engine's own "absent means not proved"
      // contract, preserved rather than flattened to an empty array.
      splitMerges: diff.splitMerges?.map((claim) => ({
        kind: claim.kind,
        confidence: claim.confidence,
        whole: claim.whole.key,
        pieces: claim.pieces.map((piece) => piece.key),
      })),
      successors: diff.successors?.map((claim) => ({
        confidence: claim.confidence,
        base: claim.base.key,
        head: claim.head.key,
        overlap: claim.overlap,
        distance: claim.distance,
      })),
      identityMap: {
        in: options.identityIn
          ? { path: options.identityIn, applied: applied.size, ignored }
          : undefined,
        out: written ? { path: written.path, entries: written.entries.length } : undefined,
      },
      lineage: {
        in: options.lineageIn ? { path: options.lineageIn } : undefined,
        out: lineageWritten
          ? { path: lineageWritten.path, entries: lineageWritten.entries.length }
          : undefined,
      },
      keyProperty: keyProperty ?? null,
      duplicateAuthoredKeys: [...duplicateAuthoredKeys.keys()],
    });
    return;
  }

  printReport({
    basePath,
    headPath,
    diff,
    appliedCount: applied.size,
    ignoredCount: ignored,
    identityIn: options.identityIn,
    written,
    lineageIn: options.lineageIn,
    lineageWritten,
    keyProperty,
  });
}

/**
 * Refuse to run at all if `--identity-out` names one of the two input models.
 *
 * The sidecar is a JSON document. Writing it over an IFC file destroys the
 * user's model, and a mistyped or shell-completed path is all it takes — the
 * two arguments right before it are IFC paths. So this is checked first, and
 * the command exits without reading, comparing, or writing anything.
 *
 * Two independent tests, because a path string is not a file:
 *
 * 1. Resolved paths are equal. Catches `./v1.ifc` vs `v1.ifc` vs `sub/../v1.ifc`
 *    with no filesystem access, and is the whole answer on a platform where
 *    `stat` reports no usable inode.
 * 2. The output already exists AND is the same file as an input, by device +
 *    inode. This is the exhaustive test: it catches a symlink, a hard link, a
 *    bind mount, and `V1.IFC` on a case-insensitive filesystem — every way two
 *    different strings can name one file. It is also sufficient on its own for
 *    the destructive case, because a path that does not resolve to an existing
 *    file cannot be overwriting an input: the inputs must exist to be read.
 *
 * `--identity-in` and `--identity-out` naming the SAME sidecar is not checked
 * here, because that is the carry-forward workflow this feature is built around
 * (read the accepted claims, write back the ones that still held).
 */
async function refuseOverwritingAnInput(options: ContentDiffOptions): Promise<void> {
  for (const [flag, target] of [
    ['--identity-out', options.identityOut],
    ['--lineage-out', options.lineageOut],
  ] as const) {
    if (target === undefined) continue;
    const out = resolve(target);
    const outStat = await statOrUndefined(target);
    for (const [label, input] of [
      ['base model', options.basePath],
      ['head model', options.headPath],
    ] as const) {
      if (resolve(input) !== out && !isSameFile(outStat, await statOrUndefined(input))) continue;
      fatal(
        `${flag} ${target} is the ${label} (${input}). ` +
          'Writing there would overwrite the input file.',
      );
    }
  }
}

async function statOrUndefined(path: string): Promise<Stats | undefined> {
  // A missing or unreadable path cannot be an input file being overwritten;
  // reading the models is what reports it, with its own message.
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

function isSameFile(a: Stats | undefined, b: Stats | undefined): boolean {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

/**
 * Read one of the two input models, reporting a missing or unreadable path the
 * way the rest of the command reports problems rather than throwing a raw
 * `ENOENT` stack at the user — the same treatment `readVerifiedSidecar` already
 * gives the sidecar.
 */
async function readModel(path: string): Promise<Uint8Array> {
  try {
    return await readFile(path);
  } catch (error) {
    return fatal(`Cannot read ${path}: ${(error as Error).message}`);
  }
}

/**
 * Read a sidecar and refuse it unless it was verified against exactly these two
 * files.
 *
 * This is the whole reason the sidecar pins both content digests. A rename list
 * with no idea which revisions a human looked at when accepting it is not a
 * claim, it is a guess with a filename; replayed against the wrong pair it
 * either silently does nothing or asserts an identity nobody reviewed. There is
 * deliberately no override flag: the fix for a mismatch is to re-run the
 * comparison that produced the claims, which is one command.
 */
async function readVerifiedSidecar(
  path: string,
  models: { base: ModelIdentity; head: ModelIdentity; keyProperty?: string },
): Promise<IdentityMapSidecar> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (error) {
    return fatal(`Cannot read identity map ${path}: ${(error as Error).message}`);
  }
  let sidecar: IdentityMapSidecar;
  try {
    sidecar = parseIdentityMapSidecar(text);
  } catch (error) {
    return fatal((error as Error).message);
  }
  const problems = identityMapSidecarMismatches(sidecar, models);
  if (problems.length > 0) {
    return fatal(
      `Identity map ${path} was not verified against these files:\n  ${problems.join('\n  ')}`,
    );
  }
  return sidecar;
}

/**
 * The claims the output sidecar should carry: the incoming ones that still
 * applied, plus the ones this run's content matching established.
 *
 * Carrying the incoming claims forward is not bookkeeping, it is the point.
 * An applied alias matches its pair by key, so that pair is no longer in
 * `contentMatches` — deriving the output from the matches alone would drop
 * exactly the claims that worked, and `--identity-in x --identity-out x` would
 * erase the map a little more on every run. Their original `reason` is
 * preserved so a hand-written claim does not silently become an engine-derived
 * one. Incoming claims that did NOT apply (stale, or colliding) are dropped:
 * the sidecar records what held against these two files, not what someone once
 * hoped.
 */
function mergeIdentityClaims(
  incoming: IdentityMapSidecar | undefined,
  applied: ReadonlyMap<string, string>,
  matches: readonly ContentMatch<DiffRef>[] | undefined,
): IdentityMapEntry[] {
  const entries: IdentityMapEntry[] = [];
  if (incoming) {
    const reasons = new Map<string, string>();
    for (const entry of incoming.entries) {
      if (!reasons.has(entry.here)) reasons.set(entry.here, entry.reason);
    }
    for (const [here, base] of applied) {
      entries.push({ base, here, reason: reasons.get(here) ?? 'carried forward' });
    }
  }
  entries.push(...identityMapFromContentMatches(matches));
  return entries;
}
