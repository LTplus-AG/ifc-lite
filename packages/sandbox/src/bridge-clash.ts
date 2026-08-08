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
 */

import type { NamespaceSchema } from './bridge-schema.js';
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
          `(e.g. "IfcWall"). Got ${tag === undefined ? 'undefined' : JSON.stringify(tag)}.`,
      );
    }
  }
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
        tsReturn: 'Promise<unknown>',
        call: (sdk, args) => {
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
          return sdk.clash.run(elements, rules, options);
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
        tsReturn: 'Promise<unknown>',
        call: (sdk, args) => {
          const elements = args[0] as ClashElement[];
          if (!Array.isArray(elements)) {
            throw new Error('bim.clash.matrix: elements must be an array of ClashElement');
          }
          assertClashElements(elements, 'bim.clash.matrix');
          const options = args[1] as ClashMatrixOptions | undefined;
          return sdk.clash.matrix(elements, options);
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'Run the out-of-the-box discipline clash matrix when you just want the standard cross-discipline interference report.',
        },
      },
      {
        name: 'group',
        doc: 'Group a clash result into clusters (the unit of a single BCF topic). by defaults to "cluster".',
        args: ['dump', 'string'],
        paramNames: ['result', 'by'],
        tsParamTypes: [
          'unknown',
          '"cluster" | "rule" | "typePair" | "element" | "storey" | undefined',
        ],
        tsReturn: 'unknown[]',
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
        tsReturn: 'unknown[]',
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
        tsReturn: 'unknown[]',
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
