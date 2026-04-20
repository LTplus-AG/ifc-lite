/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge Schema — declarative definitions for sandbox bridge methods.
 *
 * Instead of hand-writing QuickJS handle marshaling for each SDK method,
 * we define a schema (method name, arg types, SDK call, return type).
 * A generic builder creates the QuickJS functions from the schema.
 *
 * Benefits:
 * - Adding a new SDK method = adding one schema entry (no boilerplate)
 * - Impossible to forget handle disposal (generic builder handles it)
 * - Consistent arg validation and error handling
 */

import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';
import type { BimContext, EntityRef } from '@ifc-lite/sdk';
import type { SandboxPermissions } from './types.js';

import { creatorRegistry } from './creator-registry.js';
import { buildModelNamespace } from './bridge-model.js';
import { buildQueryNamespace } from './bridge-query.js';
import { buildViewerNamespace } from './bridge-viewer.js';
import { buildMutateNamespace } from './bridge-mutate.js';
import { buildCreateMethods } from './bridge-create.js';
import { buildFilesNamespace } from './bridge-files.js';
import { buildExportNamespace } from './bridge-export.js';
import { buildScheduleNamespace } from './bridge-schedule.js';

// ============================================================================
// Schema Types
// ============================================================================

/** How to unmarshal a single argument from QuickJS */
type ArgType =
  | 'string'       // vm.getString(handle)
  | 'number'       // vm.getNumber(handle)
  | 'dump'         // vm.dump(handle) — generic JSON-like value
  | 'entityRefs'   // vm.dump(handle) — array of entities, map to .ref
  | '...strings'   // rest: collect all remaining args as strings

/** How to marshal the return value back to QuickJS */
type ReturnType =
  | 'void'       // No return value
  | 'string'     // Return as vm.newString()
  | 'value'      // Return as marshalValue() (generic)

export type LlmTaskIntent =
  | 'create'
  | 'inspect'
  | 'modify'
  | 'visualize'
  | 'repair'
  | 'export';

export type MethodPlacementKind =
  | 'storey-relative'
  | 'world'
  | 'wall-local'
  | 'explicit-placement'
  | 'element-target';

export interface MethodSemanticContract {
  /** High-level tasks where this method is especially relevant */
  taskTags?: LlmTaskIntent[];
  /** Expected placement frame for geometry methods */
  placement?: MethodPlacementKind;
  /** Required keys inside the params object */
  requiredKeys?: string[];
  /** Alternative required key groups, where any one group is valid */
  anyOfKeys?: string[][];
  /** Numeric keys that should be positive when provided as literals */
  positiveKeys?: string[];
  /** Point-array arity checks for literal vectors */
  pointArity?: Record<string, number>;
  /** Axis keys that must not collapse to the same point */
  axisPair?: [string, string];
  /** Keys that should never be used with this helper */
  forbiddenKeys?: Array<{ key: string; message: string }>;
  /** Shared custom validator hook name for prompt/preflight/hints */
  customValidationId?: 'slab-shape' | 'roof-shape' | 'generic-element' | 'axis-element';
  /** Guidance for when to choose this helper */
  useWhen?: string;
  /** Warnings or repair hints attached to the contract */
  cautions?: string[];
  /** Whether repairs should inspect the loaded model first */
  inspectFirst?: boolean;
}

export interface MethodSchema {
  /** Method name exposed in QuickJS (e.g., 'colorize') */
  name: string;
  /** Human-readable description for editor completions */
  doc: string;
  /** Argument types, in order */
  args: ArgType[];
  /** Parameter names for generated TypeScript declarations (optional) */
  paramNames?: string[];
  /** Override TypeScript parameter types (indexed by position, undefined = use default) */
  tsParamTypes?: (string | undefined)[];
  /** TypeScript return type for generated declarations (default: inferred from returns) */
  tsReturn?: string;
  /** Execute the SDK call and return a native JS value */
  call: (sdk: BimContext, args: unknown[], context: BridgeCallContext) => unknown;
  /** How to marshal the return value */
  returns: ReturnType;
  /** Shared semantic contract for prompts, validation, and repair hints */
  llmSemantics?: MethodSemanticContract;
}

export interface NamespaceSchema {
  /** Namespace name on the `bim` object (e.g., 'viewer') */
  name: string;
  /** Human-readable description for editor completions */
  doc: string;
  /** Permission key — if false, this namespace is skipped */
  permission: keyof SandboxPermissions;
  /** Methods in this namespace */
  methods: MethodSchema[];
}

export interface BridgeCallContext {
  sandboxSessionId: string;
}

// ============================================================================
// Schema Definitions
// ============================================================================

export const NAMESPACE_SCHEMAS: NamespaceSchema[] = [
  // ── bim.model ──────────────────────────────────────────────
  buildModelNamespace(),

  // ── bim.query ─────────────────────────────────────────────
  buildQueryNamespace(),

  // ── bim.viewer ─────────────────────────────────────────────
  buildViewerNamespace(),

  // ── bim.mutate ─────────────────────────────────────────────
  buildMutateNamespace(),

  // ── bim.lens ───────────────────────────────────────────────
  {
    name: 'lens',
    doc: 'Lens visualization',
    permission: 'lens',
    methods: [
      {
        name: 'presets',
        doc: 'Get built-in lens presets',
        args: [],
        tsReturn: 'unknown[]',
        call: (sdk) => sdk.lens.presets(),
        returns: 'value',
      },
    ],
  },

  // ── bim.create ─────────────────────────────────────────────
  //
  // Auto-discovered from IfcCreator.prototype at module load.
  // Adding a new public method to IfcCreator automatically exposes it
  // in the sandbox — no manual bridge wiring needed.
  //
  {
    name: 'create',
    doc: 'IFC creation from scratch',
    permission: 'export',  // reuses export permission — creation produces files
    methods: buildCreateMethods(),
  },

  // ── bim.files ──────────────────────────────────────────────
  buildFilesNamespace(),

  // ── bim.schedule ───────────────────────────────────────────
  buildScheduleNamespace(),

  // ── bim.export ─────────────────────────────────────────────
  buildExportNamespace(),
];

// ============================================================================
// Generic Builder
// ============================================================================

/**
 * Build all schema-defined namespaces on the `bim` handle.
 * Skips namespaces whose permission is disabled.
 */
export function buildSchemaNamespaces(
  vm: QuickJSContext,
  bimHandle: QuickJSHandle,
  sdk: BimContext,
  permissions: Required<SandboxPermissions>,
  context: BridgeCallContext,
): void {
  for (const schema of NAMESPACE_SCHEMAS) {
    if (!permissions[schema.permission]) continue;
    buildNamespace(vm, bimHandle, sdk, schema, context);
  }
}

function buildNamespace(
  vm: QuickJSContext,
  bimHandle: QuickJSHandle,
  sdk: BimContext,
  schema: NamespaceSchema,
  context: BridgeCallContext,
): void {
  const nsHandle = vm.newObject();

  for (const method of schema.methods) {
    const fn = vm.newFunction(method.name, (...handles: QuickJSHandle[]) => {
      // Unmarshal arguments
      const nativeArgs = unmarshalArgs(vm, handles, method.args);

      // Call the SDK
      const result = method.call(sdk, nativeArgs, context);

      // Marshal return value
      return marshalReturn(vm, result, method.returns);
    });
    vm.setProp(nsHandle, method.name, fn);
    fn.dispose();
  }

  vm.setProp(bimHandle, schema.name, nsHandle);
  nsHandle.dispose();
}

export function disposeSchemaNamespaceSession(context: BridgeCallContext): void {
  creatorRegistry.removeSession(context.sandboxSessionId);
}

/** Unmarshal QuickJS handles to native JS values based on arg schema */
function unmarshalArgs(vm: QuickJSContext, handles: QuickJSHandle[], argTypes: ArgType[]): unknown[] {
  const result: unknown[] = [];
  for (let i = 0; i < argTypes.length; i++) {
    switch (argTypes[i]) {
      case 'string': {
        const handle = handles[i];
        result.push(handle ? vm.getString(handle) : undefined);
        break;
      }
      case 'number': {
        const handle = handles[i];
        result.push(handle ? vm.getNumber(handle) : undefined);
        break;
      }
      case 'dump': {
        const handle = handles[i];
        result.push(handle ? vm.dump(handle) : undefined);
        break;
      }
      case 'entityRefs': {
        const handle = handles[i];
        if (!handle) { result.push([]); break; }
        const raw = vm.dump(handle) as Array<{ ref?: EntityRef } & EntityRef>;
        result.push(raw.map(r => r.ref ?? r));
        break;
      }
      case '...strings': {
        // Collect all remaining handles as strings
        const rest: string[] = [];
        for (let j = i; j < handles.length; j++) {
          if (handles[j]) rest.push(vm.getString(handles[j]));
        }
        result.push(rest);
        return result; // No more args after rest
      }
    }
  }
  return result;
}

/** Marshal a native JS value back to a QuickJS handle */
function marshalReturn(vm: QuickJSContext, value: unknown, type: ReturnType): QuickJSHandle | undefined {
  switch (type) {
    case 'void':
      return undefined;
    case 'string':
      return typeof value === 'string' ? vm.newString(value) : vm.null;
    case 'value':
      return marshalValue(vm, value);
  }
}

/** Recursively convert a native JS value to a QuickJS handle */
export function marshalValue(vm: QuickJSContext, value: unknown): QuickJSHandle {
  if (value === null || value === undefined) return vm.null;
  if (typeof value === 'string') return vm.newString(value);
  if (typeof value === 'number') return vm.newNumber(value);
  if (typeof value === 'boolean') return value ? vm.true : vm.false;

  if (Array.isArray(value)) {
    const arr = vm.newArray();
    for (let i = 0; i < value.length; i++) {
      const item = marshalValue(vm, value[i]);
      vm.setProp(arr, i, item);
      item.dispose();
    }
    return arr;
  }

  if (typeof value === 'object') {
    const obj = vm.newObject();
    for (const [k, v] of Object.entries(value)) {
      const handle = marshalValue(vm, v);
      vm.setProp(obj, k, handle);
      handle.dispose();
    }
    return obj;
  }

  return vm.null;
}
