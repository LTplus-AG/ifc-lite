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
 * Keep this in sync with `@ifc-lite/sandbox/schema` (NAMESPACE_SCHEMAS).
 */

export interface NamespaceMapping {
  /** Default capabilities required for any call inside this namespace. */
  defaultCapabilities: readonly string[];
  /** Per-method overrides. Method name → capability list. */
  methods?: Record<string, readonly string[]>;
}

export const INFERENCE_CATALOGUE: Record<string, NamespaceMapping> = {
  model: {
    defaultCapabilities: ['model.read'],
  },
  query: {
    defaultCapabilities: ['model.read'],
  },
  store: {
    defaultCapabilities: ['model.read'],
  },
  viewer: {
    defaultCapabilities: ['viewer.read'],
    methods: {
      colorize: ['viewer.colorize'],
      color: ['viewer.colorize'],
      setColors: ['viewer.colorize'],
      isolate: ['viewer.isolate'],
      hide: ['viewer.isolate'],
      show: ['viewer.isolate'],
      reset: ['viewer.isolate'],
      flyTo: ['viewer.fly'],
      fly: ['viewer.fly'],
      setCamera: ['viewer.fly'],
      setSection: ['viewer.section'],
      clearSection: ['viewer.section'],
      // selection-reading methods stay at the default viewer.read
    },
  },
  mutate: {
    // Conservative: mutate.* defaults to wildcard. The promote dialog
    // surfaces this as red and asks the user to narrow.
    defaultCapabilities: ['model.mutate:*'],
    methods: {
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
    },
  },
  schedule: {
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
  const entry = INFERENCE_CATALOGUE[namespace];
  if (!entry) return [];
  const specific = entry.methods?.[method];
  if (specific) return specific;
  return entry.defaultCapabilities;
}

/** True iff the namespace is recognised. */
export function isKnownNamespace(namespace: string): boolean {
  return namespace in INFERENCE_CATALOGUE;
}
