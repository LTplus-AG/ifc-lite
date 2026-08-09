/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge schema - bim.clash namespace methods.
 *
 * Exposes geometric clash detection into the QuickJS sandbox. The
 * namespace is read-only analysis: it consumes caller-provided
 * ClashElement[] (meshed by the host) and produces clash results,
 * groups, and the standard discipline rule presets. It performs no
 * meshing and mutates no model, so it reuses the least-privileged
 * read-only `query` permission - same trust level as bim.query.* and
 * bim.schedule.*.
 *
 * Object / array params (elements, rules, results, options) cross the
 * QuickJS boundary via the 'dump' arg type, matching the existing
 * bridge methods. Each call delegates to sdk.clash.*.
 *
 * The `BimClash.*` names in `tsReturn` / `tsParamTypes` are NOT declared here.
 * `scripts/generate-bim-globals.mjs` extracts those declarations from
 * `packages/clash/src` itself and emits them into `bim-globals.d.ts` as
 * `declare namespace BimClash`, so this file names the real engine types
 * rather than carrying a copy of them that could drift (#2422).
 *
 * The `tsParamTypes` for `elements` are deliberately NOT `BimClash.ClashElement`:
 * `ClashElement` carries `Float32Array` / `Uint32Array` / `AABB`, which is what
 * the HOST builds, whereas a script hands the same fields across the `dump`
 * boundary as plain arrays. Those two shapes are different, so the inline
 * spelling below is the accurate one.
 */

import type { BridgeCallContext, NamespaceSchema } from './bridge-schema.js';
import type {
  ClashElement,
  ClashRule,
  ClashResult,
  ClashMode,
  ClashGroupBy,
  ClashRunOptions,
  ClashMatrixOptions,
} from '@ifc-lite/sdk';

/**
 * Describe a rejected `tag` value without ever throwing and without growing
 * with the value.
 *
 * `JSON.stringify` was the obvious choice and the wrong one: it throws outright
 * on a `bigint`, and renders a `symbol`, a `function` and `undefined` all as
 * the literal text `undefined`. A validator whose own error path can throw, or
 * cannot tell "missing" from "a function", is the exact defect shape this
 * validator exists to remove.
 */
function describeTagValue(tag: unknown): string {
  if (tag === undefined) return 'undefined';
  if (tag === null) return 'null';
  switch (typeof tag) {
    case 'string': return 'an empty string';
    case 'number': return `the number ${String(tag)}`;
    case 'boolean': return `the boolean ${String(tag)}`;
    case 'bigint': return 'a bigint';
    case 'symbol': return 'a symbol';
    case 'function': return 'a function';
    default: return Array.isArray(tag) ? 'an array' : 'an object';
  }
}

/**
 * Check the one `ClashElement` field the engine dereferences before it can
 * report anything useful about it (#2305).
 *
 * `elements` crosses the boundary as `dump` — raw, script-authored data with no
 * type checking behind it — and `ClashElement.tag` is required: it is the IFC
 * type name (`IfcWall`, the `store.entities.getTypeName(id)` rendering) that
 * every rule selector matches against. An element without one made
 * `matchesSelector` do `undefined.toUpperCase()` deep inside the engine, which
 * named neither the element nor the field, and — because the engine is async —
 * arrived as an unhandled rejection rather than a script error.
 *
 * Checked here rather than guarded in the engine because the value is not
 * optional by contract: a tagless element cannot be selected by any rule, so
 * silently matching or skipping it would hand back a clash report that is
 * quietly missing an element the caller believes it tested.
 */
function assertClashElements(elements: unknown[], method: string): void {
  for (let i = 0; i < elements.length; i += 1) {
    const element = elements[i];
    if (typeof element !== 'object' || element === null) {
      throw new Error(`${method}: elements[${i}] must be a ClashElement object, got ${element === null ? 'null' : typeof element}`);
    }
    const tag = (element as { tag?: unknown }).tag;
    if (typeof tag !== 'string' || tag === '') {
      throw new Error(
        `${method}: elements[${i}].tag must be a non-empty string — the IFC type name that rule selectors match ` +
          `(e.g. "IfcWall"). Got ${describeTagValue(tag)}.`,
      );
    }
  }
}

/**
 * Attach the run's cancellation signal to the engine settings.
 *
 * Clash detection is the only bridge work that can run for minutes, and until
 * this was threaded the sandbox could only stop *waiting* for it: on a timed-out
 * or disposed run the engine kept intersecting geometry to completion in the
 * background, on the user's machine, for a result nobody would read.
 *
 * `options` arrives as `dump` — raw script data, and often absent — so it is
 * spread rather than mutated, and the signal is applied last: a script cannot
 * construct a real `AbortSignal`, so whatever it put under that key is not one.
 */
function withHostSignal<T extends { signal?: AbortSignal }>(
  options: T | undefined,
  context: BridgeCallContext,
): T & { signal: AbortSignal | undefined } {
  return { ...options, signal: context.hostSignal } as T & { signal: AbortSignal | undefined };
}

export function buildClashNamespace(): NamespaceSchema {
  return {
    name: 'clash',
    doc: 'Geometric clash / interference detection over host-meshed ClashElement[]. Read-only analysis - selectors are IFC-type globs (e.g. "IfcDuct*|IfcPipe*", "!IfcSpace"), never GlobalIds. The host meshes the model and builds the elements.',
    permission: 'query',
    methods: [
      {
        name: 'run',
        doc: 'Run a custom set of clash rules over the elements. Each rule is { id, name, a, b?, mode: "hard"|"clearance", tolerance?, clearance?, severity? } where a/b are IFC-type selectors (omit b for a self-clash within a).',
        args: ['dump', 'dump', 'dump'],
        paramNames: ['elements', 'rules', 'options'],
        tsParamTypes: [
          // Spelled out rather than `unknown[]`: this is what the script (or the
          // LLM writing it) has to build by hand, and `tag` — the IFC type name
          // every selector matches against — is the field whose absence crashed
          // a production run (#2305).
          'Array<{ key: string; ref: number; model: string; tag: string; name?: string; storey?: string; bounds: { min: [number, number, number]; max: [number, number, number] }; positions: number[]; indices: number[] }>',
          'Array<{ id: string; name: string; a: string; b?: string; mode: "hard" | "clearance"; tolerance?: number; clearance?: number; severity?: "critical" | "major" | "minor" | "info" }>',
          '{ tolerance?: number; excludeVoidsAndHosts?: boolean; maxCandidatePairs?: number } | undefined',
        ],
        // `sdk.clash.run` is declared `Promise<ClashResult>` and the result is a
        // plain object graph all the way down (arrays, numbers, strings), so it
        // survives `marshalValue` field-for-field. Named rather than inlined:
        // the closure is 12 types, and the declaration file's job is to be
        // readable by the script author and the LLM writing for them.
        tsReturn: 'Promise<BimClash.ClashResult>',
        call: (sdk, args, context) => {
          const elements = args[0] as ClashElement[];
          const rules = args[1] as ClashRule[];
          if (!Array.isArray(elements)) {
            throw new Error('bim.clash.run: elements must be an array of ClashElement');
          }
          if (!Array.isArray(rules)) {
            throw new Error('bim.clash.run: rules must be an array of ClashRule');
          }
          assertClashElements(elements, 'bim.clash.run');
          const options = args[2] as ClashRunOptions | undefined;
          return sdk.clash.run(elements, rules, withHostSignal(options, context));
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'Detect interferences with bespoke rules. Pass host-meshed ClashElement[] plus rules selecting element groups by IFC type.',
        },
      },
      {
        name: 'matrix',
        doc: 'Run the standard discipline clash matrix (MEP x STR, HVAC x ARCH, ...). options.mode picks the preset detection mode; remaining options are forwarded as run settings.',
        args: ['dump', 'dump'],
        paramNames: ['elements', 'options'],
        tsParamTypes: [
          'Array<{ key: string; ref: number; model: string; tag: string; name?: string; storey?: string; bounds: { min: [number, number, number]; max: [number, number, number] }; positions: number[]; indices: number[] }>',
          '{ mode?: "hard" | "clearance"; tolerance?: number; excludeVoidsAndHosts?: boolean; maxCandidatePairs?: number } | undefined',
        ],
        tsReturn: 'Promise<BimClash.ClashResult>',
        call: (sdk, args, context) => {
          const elements = args[0] as ClashElement[];
          if (!Array.isArray(elements)) {
            throw new Error('bim.clash.matrix: elements must be an array of ClashElement');
          }
          assertClashElements(elements, 'bim.clash.matrix');
          const options = args[1] as ClashMatrixOptions | undefined;
          return sdk.clash.matrix(elements, withHostSignal(options, context));
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'Run the out-of-the-box discipline clash matrix when you just want the standard cross-discipline interference report.',
        },
      },
      {
        name: 'group',
        doc: 'Group a clash result into clusters (the unit of a single BCF topic). By default, grouping uses "cluster".',
        args: ['dump', 'string'],
        paramNames: ['result', 'by'],
        tsParamTypes: [
          // Exactly what the runtime accepts — no less, and no more.
          //
          // The guard below requires a `clashes` array and nothing else, and
          // `groupClashes` dereferences exactly one field of its argument
          // (`const clashes = result.clashes`, grouping.ts). So
          // `bim.clash.group({ clashes: [] }, 'rule')` is a VALID call, and
          // declaring the full `ClashResult` here would reject at type level
          // something the runtime accepts (#2422 review).
          //
          // That is the mirror image of the defect this change fixes: the old
          // `Promise<unknown>` returns UNDERSTATED the runtime, and a required
          // `ClashResult` parameter would OVERSTATE it. `Pick` rather than a
          // literal `{ clashes: ... }` so the field's type keeps tracking the
          // engine, and so renaming it upstream is a compile error here rather
          // than a silent mismatch.
          'Pick<BimClash.ClashResult, "clashes"> & Partial<BimClash.ClashResult>',
          '"cluster" | "rule" | "typePair" | "element" | "storey" | undefined',
        ],
        tsReturn: 'BimClash.ClashGroup[]',
        call: (sdk, args) => {
          const result = args[0] as ClashResult;
          if (!result || typeof result !== 'object' || !Array.isArray(result.clashes)) {
            throw new Error('bim.clash.group: result must be a ClashResult (with a clashes array)');
          }
          const by = args[1] as ClashGroupBy | undefined;
          return sdk.clash.group(result, by);
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'Cluster a clash result into BCF-ready groups before exporting issues.',
        },
      },
      {
        name: 'presets',
        doc: 'Get the built-in discipline-pair rule presets.',
        args: [],
        // `ClashRulePreset`, not `ClashRule`: a preset is the discipline pair
        // (`selectorA`/`selectorB` + a description), and `disciplineRules()` is
        // what turns presets into runnable rules.
        tsReturn: 'BimClash.ClashRulePreset[]',
        call: (sdk) => sdk.clash.presets(),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'Inspect the standard discipline-pair presets to understand or customise the clash matrix.',
        },
      },
      {
        name: 'disciplineRules',
        doc: 'Get the standard discipline matrix as runnable clash rules. mode picks the detection mode ("hard" | "clearance").',
        args: ['string'],
        paramNames: ['mode'],
        tsParamTypes: ['"hard" | "clearance" | undefined'],
        tsReturn: 'BimClash.ClashRule[]',
        call: (sdk, args) => sdk.clash.disciplineRules(args[0] as ClashMode | undefined),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'Get the discipline matrix as editable rules to tweak before passing to bim.clash.run.',
        },
      },
    ],
  };
}
