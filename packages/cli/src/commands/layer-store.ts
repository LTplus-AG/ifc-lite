/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Local layer store for `ifc-lite layer` / `ifc-lite ref` commands.
 *
 * Rooted at `.ifc-lite/` of the cwd (overridable with `--store <dir>`):
 *
 *   .ifc-lite/layers/<blake3 hex>.ifcx   published layer documents
 *   .ifc-lite/refs.json                  named refs → ordered layer ids
 *   .ifc-lite/draft.json                 draft descriptor (layer create)
 *
 * Spec: docs/architecture/layer-prs/09-cli.md.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { computeLayerId, computeStackHash } from '@ifc-lite/ifcx';
import type { RefEntry } from '@ifc-lite/merge';
import { getFlag } from '../output.js';

let atomicWriteSeq = 0;

/**
 * Write via temp file + rename so a crash or a concurrent CLI process
 * never leaves a torn refs.json or layer file behind.
 */
function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${atomicWriteSeq++}.tmp`;
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, path);
}

// Ref shapes are owned by the shared merge flow (`@ifc-lite/merge`
// ref-flow.ts) so the CLI store and the registry store cannot drift.
export type { RefEntry, RefPolicy } from '@ifc-lite/merge';

export interface RefsFile {
  refs: Record<string, RefEntry>;
}

/** Draft descriptor recorded by `ifc-lite layer create`. */
export interface DraftDescriptor {
  /** Base ref name ('-' for none). */
  base: string;
  /** Stack hash of the base ref at draft-creation time. */
  baseStackHash: string;
  intent: string;
  scope: string[];
  created: string;
}

export interface LayerStore {
  dir: string;
}

/** Open (without creating) a store rooted at `dir` or `<cwd>/.ifc-lite`. */
export function openStore(dir?: string): LayerStore {
  return { dir: resolve(dir ?? join(process.cwd(), '.ifc-lite')) };
}

/** Store from CLI args: honours the `--store <dir>` override. */
export function storeFromArgs(args: string[]): LayerStore {
  return openStore(getFlag(args, '--store'));
}

function layersDir(store: LayerStore): string {
  return join(store.dir, 'layers');
}

function refsPath(store: LayerStore): string {
  return join(store.dir, 'refs.json');
}

function draftPath(store: LayerStore): string {
  return join(store.dir, 'draft.json');
}

// ---------------------------------------------------------------------------
// refs.json
// ---------------------------------------------------------------------------

export function readRefs(store: LayerStore): RefsFile {
  if (!existsSync(refsPath(store))) return { refs: {} };
  const parsed: unknown = JSON.parse(readFileSync(refsPath(store), 'utf-8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Corrupt refs.json at ${refsPath(store)}: expected an object`);
  }
  const refs = (parsed as { refs?: unknown }).refs;
  if (typeof refs !== 'object' || refs === null || Array.isArray(refs)) {
    throw new Error(`Corrupt refs.json at ${refsPath(store)}: missing "refs" object`);
  }
  for (const [name, entry] of Object.entries(refs)) {
    const candidate = entry as Partial<RefEntry> | null;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      !Array.isArray(candidate.layers) ||
      !candidate.layers.every((id) => typeof id === 'string')
    ) {
      throw new Error(
        `Corrupt refs.json at ${refsPath(store)}: ref "${name}" must have layers: string[]`
      );
    }
    const policy = candidate.policy;
    if (policy !== undefined) {
      const okApproval =
        policy.requireHumanApproval === undefined || typeof policy.requireHumanApproval === 'boolean';
      const okChecks =
        policy.requiredChecks === undefined ||
        (Array.isArray(policy.requiredChecks) && policy.requiredChecks.every((c) => typeof c === 'string'));
      if (typeof policy !== 'object' || policy === null || !okApproval || !okChecks) {
        throw new Error(`Corrupt refs.json at ${refsPath(store)}: ref "${name}" has an invalid policy`);
      }
    }
  }
  return { refs: refs as Record<string, RefEntry> };
}

export function writeRefs(store: LayerStore, refs: RefsFile): void {
  mkdirSync(store.dir, { recursive: true });
  writeFileAtomic(refsPath(store), `${JSON.stringify(refs, null, 2)}\n`);
}

export function getRef(store: LayerStore, name: string): RefEntry | undefined {
  return readRefs(store).refs[name];
}

export function requireRef(store: LayerStore, name: string): RefEntry {
  const entry = getRef(store, name);
  if (!entry) throw new Error(`No ref named "${name}" in store ${store.dir}`);
  return entry;
}

export function setRef(store: LayerStore, name: string, entry: RefEntry): void {
  const refs = readRefs(store);
  refs.refs[name] = entry;
  writeRefs(store, refs);
}

/** Stack hash of a ref's current layer list. */
export function refStackHash(store: LayerStore, name: string): string {
  return computeStackHash(requireRef(store, name).layers);
}

// ---------------------------------------------------------------------------
// layers/<hex>.ifcx
// ---------------------------------------------------------------------------

function hexOf(layerId: string): string {
  return layerId.startsWith('blake3:') ? layerId.slice('blake3:'.length) : layerId;
}

/** Persist a published layer; `file.header.id` must be its blake3 id. */
export function storeLayer(store: LayerStore, file: IfcxFile): string {
  const id = file.header.id;
  if (!id.startsWith('blake3:')) {
    throw new Error(`Layer header.id must be a blake3 content address, got "${id}"`);
  }
  mkdirSync(layersDir(store), { recursive: true });
  writeFileAtomic(join(layersDir(store), `${hexOf(id)}.ifcx`), `${JSON.stringify(file, null, 2)}\n`);
  return id;
}

export function hasLayer(store: LayerStore, layerId: string): boolean {
  return existsSync(join(layersDir(store), `${hexOf(layerId)}.ifcx`));
}

/** Resolve a full id, bare hex, or unique hex prefix to a full layer id. */
export function resolveLayerId(store: LayerStore, idOrPrefix: string): string {
  const hex = hexOf(idOrPrefix);
  if (existsSync(join(layersDir(store), `${hex}.ifcx`))) return `blake3:${hex}`;
  if (!existsSync(layersDir(store))) {
    throw new Error(`No layer "${idOrPrefix}" — store ${store.dir} has no layers`);
  }
  const matches = readdirSync(layersDir(store)).filter(
    (f) => f.endsWith('.ifcx') && f.startsWith(hex)
  );
  if (matches.length === 1) return `blake3:${matches[0].slice(0, -'.ifcx'.length)}`;
  if (matches.length === 0) throw new Error(`No layer "${idOrPrefix}" in store ${store.dir}`);
  throw new Error(`Layer id prefix "${idOrPrefix}" is ambiguous (${matches.length} matches)`);
}

export function loadLayer(store: LayerStore, layerId: string): IfcxFile {
  const id = resolveLayerId(store, layerId);
  const file = parseIfcxJson(
    readFileSync(join(layersDir(store), `${hexOf(id)}.ifcx`), 'utf-8'),
    `layer ${id}`
  );
  // Content addressing is only protection if it is checked: a layer file
  // edited or bit-rotted on disk must fail loudly here, not compose
  // silently into refs and merges.
  const actual = computeLayerId(file);
  if (actual !== id) {
    throw new Error(
      `Layer ${id} failed integrity verification — its content hashes to ${actual}. ` +
        `The file in ${layersDir(store)} was modified or corrupted after publishing.`
    );
  }
  return file;
}

/** Load a ref's layer documents, ordered weakest first. */
export function loadRefLayers(store: LayerStore, name: string): IfcxFile[] {
  return requireRef(store, name).layers.map((id) => loadLayer(store, id));
}

// ---------------------------------------------------------------------------
// draft.json
// ---------------------------------------------------------------------------

export function readDraft(store: LayerStore): DraftDescriptor | undefined {
  if (!existsSync(draftPath(store))) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(draftPath(store), 'utf-8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Corrupt draft.json at ${draftPath(store)}`);
  }
  return parsed as DraftDescriptor;
}

export function writeDraft(store: LayerStore, draft: DraftDescriptor): void {
  mkdirSync(store.dir, { recursive: true });
  writeFileAtomic(draftPath(store), `${JSON.stringify(draft, null, 2)}\n`);
}

export function deleteDraft(store: LayerStore): void {
  if (existsSync(draftPath(store))) rmSync(draftPath(store));
}

// ---------------------------------------------------------------------------
// IFCX file helpers + side resolution
// ---------------------------------------------------------------------------

export function parseIfcxJson(text: string, label: string): IfcxFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid IFCX (${label}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const file = parsed as IfcxFile;
  if (typeof file !== 'object' || file === null || typeof file.header !== 'object' || !Array.isArray(file.data)) {
    throw new Error(`Invalid IFCX (${label}): expected { header, imports, schemas, data }`);
  }
  return {
    header: file.header,
    imports: Array.isArray(file.imports) ? file.imports : [],
    schemas: typeof file.schemas === 'object' && file.schemas !== null ? file.schemas : {},
    data: file.data,
  };
}

export function readIfcxFile(path: string): IfcxFile {
  return parseIfcxJson(readFileSync(path, 'utf-8'), path);
}

export interface ResolvedSide {
  kind: 'ref' | 'layer' | 'file';
  /** Ordered layer documents (a ref's stack, or a single document). */
  layers: IfcxFile[];
  label: string;
}

/**
 * Resolve a `<layer-id|ref|file.ifcx>` argument to an ordered layer list:
 * refs win over layer ids, layer ids over file paths.
 */
export function resolveSide(store: LayerStore, spec: string): ResolvedSide {
  if (getRef(store, spec)) {
    return { kind: 'ref', layers: loadRefLayers(store, spec), label: `ref ${spec}` };
  }
  if (spec.startsWith('blake3:') || hasLayer(store, spec)) {
    const id = resolveLayerId(store, spec);
    return { kind: 'layer', layers: [loadLayer(store, id)], label: id };
  }
  if (existsSync(spec)) {
    return { kind: 'file', layers: [readIfcxFile(spec)], label: spec };
  }
  // Last chance: maybe it is a layer-id prefix.
  const id = resolveLayerId(store, spec);
  return { kind: 'layer', layers: [loadLayer(store, id)], label: id };
}

/** Short display form of a `blake3:<hex>` id. */
export function shortId(layerId: string): string {
  return hexOf(layerId).slice(0, 12);
}

/** Default principal for provenance authorship. */
export function defaultPrincipal(): string {
  return process.env.USER ?? process.env.USERNAME ?? 'unknown';
}
