/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Map `bim.<namespace>.<method>` call sites to capability requirements.
 *
 * The static analyzer (see `./capability.ts`) walks the AST of a saved
 * script, collects every `bim.<ns>.<method>` invocation, and joins each
 * one to this table to produce the minimum capability set the script
 * needs at runtime.
 *
 * The table is conservative: when a method's intent is ambiguous (e.g.
 * `bim.export.*` could produce any format), we map to a broad capability
 * with a wildcard target that the user can narrow on the review screen.
 *
 * Adding a new entry here is the *only* place where a new
 * `bim.<ns>.<method>` becomes "known" to inference. Unknown calls
 * surface as the fallback `model.read` plus a warning in the inference
 * result so the user/AI can investigate.
 *
 * Two shapes of namespace entry, and they warn differently on a miss:
 *   - FLAT (no `methods` map): every real method in the namespace is
 *     documented to share `defaultCapabilities` (e.g. `query`, `create`).
 *     A method not listed here still resolves to that default, silently —
 *     that is the intended behavior, not a gap.
 *   - DIFFERENTIATED (has a `methods` map): capability varies by method
 *     here, so the map is the namespace's *complete* classification set,
 *     not a list of exceptions. Every real bridge method gets an entry,
 *     including the ones whose answer is the namespace default (see
 *     `model.list`, `export.download`) — writing the default out is how
 *     the table records "this method was looked at". A method absent from
 *     a complete map is therefore one nobody classified: it still
 *     resolves to `defaultCapabilities` (never under-grant), but
 *     `isRecognisedMethod` reports it as unrecognised so `capability.ts`
 *     can warn.
 *
 * Keep this in sync with `@ifc-lite/sandbox/schema` (NAMESPACE_SCHEMAS).
 * Nothing machine-checks that sync, so a differentiated namespace's map
 * can fall behind a newly added bridge method. It falls behind in the
 * safe direction: the new method warns until someone classifies it.
 */

export interface NamespaceMapping {
  /** Default capabilities required for any call inside this namespace. */
  defaultCapabilities: readonly string[];
  /**
   * Per-method capabilities. Method name → capability list.
   *
   * Present only on a DIFFERENTIATED namespace, and then it must list
   * every real bridge method in that namespace — an entry repeating
   * `defaultCapabilities` is a deliberate record that the method was
   * classified, not redundancy. `isRecognisedMethod` reads membership
   * here as "the catalogue classified this method", so an omission
   * shows up to the reviewer as an unrecognised call.
   */
  methods?: Record<string, readonly string[]>;
}

export const INFERENCE_CATALOGUE: Record<string, NamespaceMapping> = {
  model: {
    defaultCapabilities: ['model.read'],
    // Differentiated: capability varies by method, so every method is
    // listed explicitly (a differentiated namespace treats a missing
    // method as a catalogue gap, not as an intended fall-through).
    methods: {
      list: ['model.read'],
      active: ['model.read'],
      activeId: ['model.read'],
      // Loads a whole new IFC document into the app — creation, not a
      // read (see host/permissions.ts: model.create "modifies the document").
      loadIfc: ['model.create'],
    },
  },
  query: {
    defaultCapabilities: ['model.read'],
  },
  store: {
    // Every real `bim.store.*` method is a document-level edit
    // (packages/sandbox/src/bridge-store.ts): the read-only default only
    // applies to a namespace call with no method (`bim.store`, untargeted).
    defaultCapabilities: ['model.read'],
    methods: {
      addEntity: ['model.create'],
      removeEntity: ['model.delete'],
      setPositionalAttribute: ['model.mutate:*'],
      addColumn: ['model.create'],
      addWall: ['model.create'],
      addSlab: ['model.create'],
      addBeam: ['model.create'],
      addDoor: ['model.create'],
      addWindow: ['model.create'],
      addSpace: ['model.create'],
      addRoof: ['model.create'],
      addPlate: ['model.create'],
      addMember: ['model.create'],
    },
  },
  viewer: {
    defaultCapabilities: ['viewer.read'],
    methods: {
      colorize: ['viewer.colorize'],
      colorizeAll: ['viewer.colorize'],
      resetColors: ['viewer.colorize'],
      color: ['viewer.colorize'],
      setColors: ['viewer.colorize'],
      isolate: ['viewer.isolate'],
      hide: ['viewer.isolate'],
      show: ['viewer.isolate'],
      resetVisibility: ['viewer.isolate'],
      reset: ['viewer.isolate'],
      flyTo: ['viewer.fly'],
      fly: ['viewer.fly'],
      setCamera: ['viewer.fly'],
      setSection: ['viewer.section'],
      clearSection: ['viewer.section'],
      // `select` writes viewer selection state, so `viewer.read` is a
      // known under-grant — `../capability/catalogue.ts` has no scope
      // that fits, and adding one changes the manifest contract rather
      // than this table. Listed at the default on purpose: a recorded
      // decision, not a method nobody looked at.
      select: ['viewer.read'],
    },
  },
  mutate: {
    // Conservative: mutate.* defaults to wildcard. The promote dialog
    // surfaces this as red and asks the user to narrow. Every real
    // method is listed at that wildcard rather than left to fall
    // through, so an unlisted `bim.mutate.*` call is a genuine miss.
    defaultCapabilities: ['model.mutate:*'],
    methods: {
      setProperty: ['model.mutate:*'],
      setAttribute: ['model.mutate:*'],
      deleteProperty: ['model.mutate:*'],
      undo: ['model.mutate:*'],
      redo: ['model.mutate:*'],
      delete: ['model.delete'],
    },
  },
  create: {
    defaultCapabilities: ['model.create'],
  },
  files: {
    defaultCapabilities: ['export.create:*'],
  },
  export: {
    defaultCapabilities: ['export.create:*'],
    methods: {
      csv: ['export.create:csv'],
      toCsv: ['export.create:csv'],
      json: ['export.create:json'],
      toJson: ['export.create:json'],
      glb: ['export.create:glb'],
      gltf: ['export.create:gltf'],
      step: ['export.create:ifc'],
      ifc: ['export.create:ifc'],
      ifcx: ['export.create:ifcx'],
      parquet: ['export.create:parquet'],
      // Writes arbitrary caller-supplied content under a caller-supplied
      // filename and mime type, so no format target is narrower than the
      // wildcard. Listed at the default on purpose: classified, not missed.
      download: ['export.create:*'],
    },
  },
  schedule: {
    defaultCapabilities: ['model.read'],
  },
  clash: {
    // Read-only geometric analysis (same trust level as query/schedule).
    defaultCapabilities: ['model.read'],
  },
  lens: {
    defaultCapabilities: [], // presets is read-only metadata
  },
};

/** Return the capabilities required for a `bim.<ns>.<method>` call. */
export function lookupNamespaceMethod(
  namespace: string,
  method: string,
): readonly string[] {
  if (!Object.prototype.hasOwnProperty.call(INFERENCE_CATALOGUE, namespace)) {
    return [];
  }
  const entry = INFERENCE_CATALOGUE[namespace];
  const specific = entry.methods
    && Object.prototype.hasOwnProperty.call(entry.methods, method)
    ? entry.methods[method]
    : undefined;
  if (specific) return specific;
  return entry.defaultCapabilities;
}

/** True iff the namespace is recognised. */
export function isKnownNamespace(namespace: string): boolean {
  return Object.prototype.hasOwnProperty.call(INFERENCE_CATALOGUE, namespace);
}

/**
 * True iff this specific `bim.<namespace>.<method>` call resolves to a
 * capability the catalogue actually classified, rather than falling
 * through to a namespace default the table never considered for this
 * method.
 *
 * `method` is `undefined` for an untargeted `bim.<namespace>` reference
 * (no method call) — that always resolves to the documented default and
 * is always recognised.
 *
 * A FLAT namespace (no `methods` map) recognises every method: the
 * table's own shape says one capability legitimately covers the whole
 * namespace. A DIFFERENTIATED namespace (has a `methods` map) only
 * recognises methods present in that map, which is why that map has to
 * list every real bridge method in the namespace including the ones
 * that land on `defaultCapabilities` — see `NamespaceMapping.methods`.
 * Read the other way round, this answers "did the catalogue classify
 * this method", not "does this method exist": the two agree only for as
 * long as a differentiated map stays complete against NAMESPACE_SCHEMAS,
 * and when it does not, the newly added method is the one that warns.
 */
export function isRecognisedMethod(namespace: string, method: string | undefined): boolean {
  if (!isKnownNamespace(namespace)) return false;
  if (!method) return true;
  const entry = INFERENCE_CATALOGUE[namespace];
  if (!entry.methods) return true;
  return Object.prototype.hasOwnProperty.call(entry.methods, method);
}
