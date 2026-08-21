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

import { HostWorkQueue, isThenable } from './bridge-async.js';
import { creatorRegistry } from './creator-registry.js';
import { buildModelNamespace } from './bridge-model.js';
import { buildQueryNamespace } from './bridge-query.js';
import { buildViewerNamespace } from './bridge-viewer.js';
import { buildMutateNamespace } from './bridge-mutate.js';
import { buildStoreNamespace } from './bridge-store.js';
import { buildCreateMethods } from './bridge-create.js';
import { buildFilesNamespace } from './bridge-files.js';
import { buildExportNamespace } from './bridge-export.js';
import { buildScheduleNamespace } from './bridge-schedule.js';
import { buildClashNamespace } from './bridge-clash.js';

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
  /**
   * Cancellation for host work this call starts (#2419), aborted when the run
   * stops waiting (`timeoutMs`) and when the sandbox is disposed. An async
   * `call:` that can take real time must forward it, or the work runs on to
   * completion on the user's machine after the run that asked for it is gone.
   *
   * Optional because the bridge supplies it, not the caller: `buildBridge` gets
   * the session-scoped half and `buildNamespace` adds the signal per call, so a
   * `call:` invoked directly by a unit test can pass a context without one.
   */
  hostSignal?: AbortSignal;
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

  // ── bim.store ──────────────────────────────────────────────
  buildStoreNamespace(),

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

  // ── bim.clash ──────────────────────────────────────────────
  buildClashNamespace(),

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
  hostWork: HostWorkQueue,
): void {
  for (const schema of NAMESPACE_SCHEMAS) {
    if (!permissions[schema.permission]) continue;
    buildNamespace(vm, bimHandle, sdk, schema, context, hostWork);
  }
}

function buildNamespace(
  vm: QuickJSContext,
  bimHandle: QuickJSHandle,
  sdk: BimContext,
  schema: NamespaceSchema,
  context: BridgeCallContext,
  hostWork: HostWorkQueue,
): void {
  // try/finally, not a bare sequence: a throw anywhere in the registration
  // loop would otherwise orphan `nsHandle` (and the in-flight `fn`), and an
  // orphaned handle makes the runtime's own dispose() abort the WASM module
  // — see disposeOrphan() below for the full mechanism (#1905).
  const nsHandle = vm.newObject();
  try {
    for (const method of schema.methods) {
      const fn = vm.newFunction(method.name, (...handles: QuickJSHandle[]) => {
        // Host-side errors (capability denials, SDK exceptions, type
        // errors) MUST be re-thrown as a plain `Error` with a string
        // message. Throwing a custom Error subclass — or any non-plain
        // object — across the QuickJS native-callback boundary leaves
        // the realm in a corrupt state: a subsequent handle access
        // throws "Lifetime not alive". Normalising to a plain Error
        // here keeps the failure a clean, catchable script exception.
        const label = `bim.${schema.name}.${method.name}`;
        try {
          const nativeArgs = unmarshalArgs(vm, handles, method.args);
          // `hostWork.signal` is read here, per call, rather than captured when
          // the namespace is built: the queue swaps in a fresh controller after
          // a run gives up waiting, so a cached signal would hand every later
          // run on this sandbox one that is already aborted.
          const result = method.call(sdk, nativeArgs, { ...context, hostSignal: hostWork.signal });
          // An async method's failure is a *rejection*, never a throw, so the
          // catch below can never see it. Marshalling the promise as a value
          // was worse than useless: `marshalValue` found no own properties on
          // it and handed the script `{}`, so the call reported a clean pass
          // carrying nothing while the rejection escaped as an unhandled host
          // error and killed the page's run (#2305). Hand the realm a real
          // promise instead — see bridge-async.ts.
          if (isThenable(result)) {
            // The resolved value goes through `marshalReturn` with this
            // method's declared `returns`, exactly as the synchronous path
            // does. Marshalling it with `marshalValue` instead would have made
            // an async method's conversion silently diverge from its own
            // schema: a `returns: 'string'` method would hand a number back as
            // a number rather than the `vm.null` the contract promises.
            return hostWork.adopt(vm, result, label, (ctx, value) =>
              marshalReturn(ctx, value, method.returns) ?? ctx.undefined,
            );
          }
          return marshalReturn(vm, result, method.returns);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Many `call:` implementations already name themselves in the message
          // they throw (`bim.clash.run: elements must be an array…`), so an
          // unconditional prefix rendered them as
          // "bim.clash.run: bim.clash.run: …". Prefix only what is not already
          // attributed.
          throw new Error(msg.startsWith(`${label}:`) ? msg : `${label}: ${msg}`);
        }
      });
      try {
        vm.setProp(nsHandle, method.name, fn);
      } finally {
        fn.dispose();
      }
    }

    vm.setProp(bimHandle, schema.name, nsHandle);
  } finally {
    nsHandle.dispose();
  }
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

/**
 * Cycle/depth limits for `marshalValue` — protect the host renderer from a
 * sandboxed script that hands back a cyclic or pathologically deep object
 * graph. Values past the depth limit serialise to `null`.
 */
const MARSHAL_MAX_DEPTH = 64;

/**
 * Free a container handle that is being abandoned because marshalling threw.
 *
 * A handle created through the context is an *unmanaged* Lifetime —
 * `QuickJSContext.dispose()` does NOT free it. An orphaned handle therefore
 * keeps its JSObject on the runtime's `gc_obj_list`, and `JS_FreeRuntime`
 * asserts `list_empty(&rt->gc_obj_list)` — an emscripten `abort()` that kills
 * the WASM module for the rest of the document lifetime (#1905).
 *
 * The caller re-throws the original error afterwards: a failing `.dispose()`
 * here only means the handle is already dead, which is the outcome we wanted,
 * and it must not mask the real cause.
 */
function disposeOrphan(handle: QuickJSHandle): void {
  try {
    handle.dispose();
  } catch (err) {
    // Already-dead handle: the outcome we wanted. Surfaced rather than
    // swallowed, because a burst of these is the signature of the very
    // ownership bug this function exists to prevent.
    console.warn('[ifc-lite/sandbox] abandoned QuickJS handle could not be disposed', err);
  }
}

/** Recursively convert a native JS value to a QuickJS handle */
export function marshalValue(vm: QuickJSContext, value: unknown): QuickJSHandle {
  return marshalValueWithGuard(vm, value, 0, new WeakSet());
}

function marshalValueWithGuard(
  vm: QuickJSContext,
  value: unknown,
  depth: number,
  stack: WeakSet<object>,
): QuickJSHandle {
  if (value === null || value === undefined) return vm.null;
  if (typeof value === 'string') return vm.newString(value);
  if (typeof value === 'number') return vm.newNumber(value);
  if (typeof value === 'boolean') return value ? vm.true : vm.false;

  if (depth >= MARSHAL_MAX_DEPTH) return vm.null;
  if (typeof value !== 'object') return vm.null;

  // Cycle guard: only objects on the *current ancestor chain* count as a
  // cycle. Removing on exit means an acyclic graph that legitimately
  // shares a sub-object across siblings (e.g. `{ a: shared, b: shared }`)
  // still serialises both occurrences fully.
  const obj = value as object;
  if (stack.has(obj)) return vm.null;
  stack.add(obj);
  try {
    // A typed array's own enumerable properties are its numeric indices —
    // walking one with `Object.entries` (the generic-object branch below)
    // hands the script `{ "0": …, "1": … }` with no `.length`, not an array.
    // `bim.export.ifc()` returns exactly this shape once STEP output exceeds
    // V8's string-length limit and the SDK falls back to `Uint8Array` chunks
    // (see step-exporter.ts), so a script that works on small models silently
    // gets junk on large ones.
    //
    // Three view kinds are excluded and fall through to the generic branch,
    // which marshals them as their actual own-property shape:
    //  - `DataView`: a byte-range accessor, not a sequence of elements. It
    //    has no index keys to mangle, and `Array.from` reads its absent
    //    `length` as 0 and answers `[]` — "zero elements" instead of "not a
    //    sequence". The generic branch gives `{}`.
    //  - `BigInt64Array` / `BigUint64Array`: their elements are bigints,
    //    which this marshaller has no representation for and turns into
    //    `null`. As an array that reads back as `[null, null]` — correct
    //    `.length`, `Array.isArray` true, indistinguishable from a genuine
    //    array of nulls. `{ "0": null, "1": null }` loses exactly as much but
    //    cannot be mistaken for a sequence of numbers the script can use.
    // The tag test rather than `instanceof` so a view from another realm
    // (a worker's structured clone) is classified the same as a local one.
    const viewTag = ArrayBuffer.isView(value) ? Object.prototype.toString.call(value) : '';
    const isElementView =
      viewTag !== '' &&
      viewTag !== '[object DataView]' &&
      viewTag !== '[object BigInt64Array]' &&
      viewTag !== '[object BigUint64Array]';
    let arrayLikeValue: unknown[] | undefined;
    if (isElementView) {
      try {
        arrayLikeValue = Array.from(value as unknown as ArrayLike<number>);
      } catch {
        // Every element read on a view whose `ArrayBuffer` has been detached
        // throws, `Array.from` included — and detaching is what transferring
        // the buffer to a worker does, i.e. the large-model export path this
        // branch was added for. Letting that escape would fail the entire
        // `bim.*` call over one value; degrade to the generic branch instead,
        // which yields `{}` (a detached view has no own keys) exactly as this
        // marshaller did before the typed-array branch existed.
        arrayLikeValue = undefined;
      }
    } else if (Array.isArray(value)) {
      arrayLikeValue = value;
    }
    if (arrayLikeValue) {
      const arr = vm.newArray();
      try {
        for (let i = 0; i < arrayLikeValue.length; i++) {
          const item = marshalValueWithGuard(vm, arrayLikeValue[i], depth + 1, stack);
          try {
            vm.setProp(arr, i, item);
          } finally {
            item.dispose();
          }
        }
      } catch (err) {
        disposeOrphan(arr);
        throw err;
      }
      return arr;
    }

    const out = vm.newObject();
    try {
      // Object.entries invokes getters, and a value in the graph may be a
      // revoked Proxy — both throw from host code we do not control.
      for (const [k, v] of Object.entries(obj)) {
        const handle = marshalValueWithGuard(vm, v, depth + 1, stack);
        try {
          vm.setProp(out, k, handle);
        } finally {
          handle.dispose();
        }
      }
    } catch (err) {
      disposeOrphan(out);
      throw err;
    }
    return out;
  } finally {
    stack.delete(obj);
  }
}
