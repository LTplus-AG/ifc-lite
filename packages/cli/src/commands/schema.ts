/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite schema
 *
 * Dump the complete SDK API schema as JSON.
 * Useful for LLM tools to discover available commands and methods.
 */

import { BimContext, QueryBuilder } from '@ifc-lite/sdk';
import { printJson, hasFlag } from '../output.js';

/**
 * Doc strings for the `BimContext` / `QueryBuilder` methods that
 * `NAMESPACE_SCHEMAS` does not name (#3763). Only prose lives here — the
 * method LIST itself is reflected off the runtime classes below, so a method
 * added or removed upstream changes the dump without an edit here, and
 * `schema.runtime-shape.test.ts` fails if the two ever disagree.
 *
 * Keyed per class, like `RUNTIME_METHOD_SIGNATURES` below (#3763 follow-up):
 * `bim` and `query` are reflected off two different prototypes, so a bare
 * name shared between them (there is none today, but nothing prevented it)
 * would otherwise read whichever entry came first.
 */
const RUNTIME_METHOD_DOCS: { bim: Record<string, string>; query: Record<string, string> } = {
  bim: {
    query: 'Start a query chain: bim.query().byType(...).toArray()',
    on: 'Subscribe to an event, e.g. bim.on("selection:changed", handler)',
  },
  query: {
    model: 'Restrict the chain to one model',
    byType: "Filter by IFC type e.g. 'IfcWall'",
    where: 'Filter by a property-set value',
    limit: 'Cap the number of results',
    offset: 'Skip the first n results',
    toArray: 'Run the chain and return the entities',
    first: 'Run the chain and return the first entity, or null',
    count: 'Run the chain and return the number of matches',
    refs: 'Run the chain and return entity refs only',
  },
};

type MethodSignature = { paramNames?: string[]; tsReturn: string };

/**
 * Parameter names and return types for `BimContext` / `QueryBuilder` methods,
 * transcribed from their own signatures in `packages/sdk/src/context.ts` and
 * `packages/sdk/src/namespaces/query.ts` (#3763 follow-up).
 *
 * Keyed per class, not by bare method name: `BimContext` and `QueryBuilder`
 * are reflected separately in `withRuntimeQueryShape`, and a future method
 * that shares a name across both classes (their param/return shapes need not
 * match) would otherwise read the wrong entry silently.
 *
 * `describe()` used to spread the sandbox bridge's own `paramNames`/`tsReturn`
 * onto these methods, with the bridge as a fallback when a method had no
 * entry here. The bridge runs a whole query synchronously and returns plain
 * data (`bim.query.byType(...): BimEntity[]`, `entity(modelId, expressId)`),
 * which is not the shape the CLI's raw `BimContext`/`QueryBuilder` have
 * (`byType(...types): this`, `entity(ref: EntityRef)`) — falling back to it
 * produced a schema entry an agent could follow into a TypeError or a chain
 * that stops one link early. `describe()` now throws instead of falling back,
 * so a new runtime method with no entry here fails the dump loudly (and
 * `schema.runtime-shape.test.ts` with it) rather than shipping mislabelled.
 */
const RUNTIME_METHOD_SIGNATURES: { bim: Record<string, MethodSignature>; query: Record<string, MethodSignature> } = {
  bim: {
    query: { tsReturn: 'QueryBuilder' },
    matchingActiveFilter: { tsReturn: 'EntityData[] | null' },
    entity: { paramNames: ['ref'], tsReturn: 'EntityData | null' },
    attributes: { paramNames: ['ref'], tsReturn: 'EntityAttributeData[]' },
    properties: { paramNames: ['ref'], tsReturn: 'PropertySetData[]' },
    quantities: { paramNames: ['ref'], tsReturn: 'QuantitySetData[]' },
    classifications: { paramNames: ['ref'], tsReturn: 'ClassificationData[]' },
    materials: { paramNames: ['ref'], tsReturn: 'MaterialData | null' },
    typeProperties: { paramNames: ['ref'], tsReturn: 'TypePropertiesData | null' },
    documents: { paramNames: ['ref'], tsReturn: 'DocumentData[]' },
    relationships: { paramNames: ['ref'], tsReturn: 'EntityRelationshipsData' },
    property: { paramNames: ['ref', 'psetName', 'propName'], tsReturn: 'string | number | boolean | null' },
    quantity: { paramNames: ['ref', 'qsetNameOrQuantityName', 'quantityName?'], tsReturn: 'number | null' },
    related: { paramNames: ['ref', 'relType', 'direction'], tsReturn: 'EntityData[]' },
    containedIn: { paramNames: ['ref'], tsReturn: 'EntityData | null' },
    contains: { paramNames: ['ref'], tsReturn: 'EntityData[]' },
    decomposedBy: { paramNames: ['ref'], tsReturn: 'EntityData | null' },
    decomposes: { paramNames: ['ref'], tsReturn: 'EntityData[]' },
    storey: { paramNames: ['ref'], tsReturn: 'EntityData | null' },
    path: { paramNames: ['ref'], tsReturn: 'EntityData[]' },
    storeys: { tsReturn: 'EntityData[]' },
    on: { paramNames: ['event', 'handler'], tsReturn: 'void' },
  },
  query: {
    model: { paramNames: ['modelId'], tsReturn: 'this' },
    byType: { paramNames: ['...types'], tsReturn: 'this' },
    where: { paramNames: ['psetName', 'propName', 'operator?', 'value?'], tsReturn: 'this' },
    limit: { paramNames: ['n'], tsReturn: 'this' },
    offset: { paramNames: ['n'], tsReturn: 'this' },
    toArray: { tsReturn: 'EntityData[]' },
    first: { tsReturn: 'EntityData | null' },
    count: { tsReturn: 'number' },
    refs: { tsReturn: 'EntityRef[]' },
  },
};

/**
 * Own value-function property names on a prototype, minus the constructor,
 * plus getters whose value is itself callable (e.g. `BimContext.prototype.on`,
 * a getter returning a bound subscription function) — the CLI exposes those
 * the same way as a method, so a filter that only checked `.value` silently
 * dropped them from the dump (#3763 follow-up).
 *
 * A getter can't be classified from the prototype alone — invoking it there
 * runs the getter with `this` bound to the bare prototype, not an instance,
 * which is exactly the state `on`'s getter needs (`this._boundOn`, set in
 * the constructor) to return the function rather than `undefined`. `instance`
 * lets a caller supply a real object to invoke the getter against; without
 * one, getters are skipped rather than guessed at.
 */
function prototypeMethods(proto: object, instance?: object): string[] {
  return Object.getOwnPropertyNames(proto).filter((name) => {
    if (name === 'constructor') return false;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (typeof desc?.value === 'function') return true;
    if (typeof desc?.get === 'function' && instance) {
      return typeof (instance as Record<string, unknown>)[name] === 'function';
    }
    return false;
  });
}

/**
 * Replace the sandbox bridge's flat `query` namespace with the two shapes the
 * CLI's `bim` object actually has.
 *
 * `NAMESPACE_SCHEMAS` describes the browser sandbox bridge, where
 * `bim.query.properties(ref)` is a real method. `ifc-lite run` / `ifc-lite eval`
 * hand scripts a raw `BimContext` instead: `query()` starts a builder and
 * `properties`, `quantities`, `relationships` and ~19 siblings sit at the top
 * level of `bim`. Emitting the bridge shape here made every `bim.query.X(...)`
 * call an agent copied out of `ifc-lite schema` throw a TypeError (#3763).
 *
 * Method lists are reflected off `BimContext.prototype` and
 * `QueryBuilder.prototype` — the objects `run`/`eval` construct — rather than
 * transcribed, so this cannot drift from the runtime. Params and return types
 * come from `RUNTIME_METHOD_SIGNATURES`, not the bridge schema: the bridge
 * describes its own (different) call shape, and copying its `paramNames` /
 * `tsReturn` here just relabelled the wrong signature (#3763 follow-up).
 *
 * The bridge's `query` namespace (`bridgeQuery` below) is a flat list of the
 * same ~20 entity-lookup methods that sit at the top level of `bim`
 * (`entity`, `properties`, `quantities`, ...). That is the namespace those
 * methods belong to on the bridge, and it is only ever used as a `doc` /
 * `llmSemantics` fallback for the `bim` prototype. It is never consulted for
 * the `query` builder-chain prototype: `QueryBuilder`'s `byType`/`where`/
 * `limit`/… have no counterpart there (the bridge runs a whole chain
 * synchronously instead of building one), so reading `bridgeMethods` by bare
 * name for that prototype could silently attach an unrelated bridge method's
 * doc to a same-named builder method. `RUNTIME_METHOD_DOCS.query` documents
 * every builder method already, so restricting the fallback to `bim` needs
 * no "no entry" carve-out.
 */
function withRuntimeQueryShape(schemas: any[]): any[] {
  const bridgeQuery = schemas.find((ns) => ns?.name === 'query');
  const bridgeMethods = new Map<string, any>(
    (bridgeQuery?.methods ?? []).map((m: any) => [m.name, m]),
  );

  const describe = (proto: 'bim' | 'query') => (name: string) => {
    const fromBridge = proto === 'bim' ? bridgeMethods.get(name) : undefined;
    const signature = RUNTIME_METHOD_SIGNATURES[proto][name];
    if (!signature) {
      // A method exists on the runtime prototype but nobody transcribed its
      // signature into RUNTIME_METHOD_SIGNATURES — fail loudly rather than
      // fall back to the bridge's (differently shaped) entry, so a new
      // BimContext/QueryBuilder method cannot ship mislabelled (#3763 follow-up).
      throw new Error(
        `RUNTIME_METHOD_SIGNATURES.${proto} has no entry for '${name}' — add its ` +
          `paramNames/tsReturn, transcribed from packages/sdk/src/context.ts or ` +
          `packages/sdk/src/namespaces/query.ts.`,
      );
    }
    return {
      doc: RUNTIME_METHOD_DOCS[proto][name] ?? fromBridge?.doc ?? name,
      name,
      paramNames: signature.paramNames,
      tsReturn: signature.tsReturn,
      llmSemantics: fromBridge?.llmSemantics,
    };
  };

  // Constructed only to invoke the `on` getter against real instance state
  // (see `prototypeMethods`) — no backend method is called during
  // construction or by this dump.
  const bimInstance = new BimContext({ backend: {} as never });

  return [
    {
      name: 'bim',
      doc: 'Top-level methods on the `bim` object (call as bim.<method>(...))',
      methods: prototypeMethods(BimContext.prototype, bimInstance).map(describe('bim')),
    },
    {
      name: 'query',
      doc: 'Query builder chain — start it with bim.query()',
      methods: prototypeMethods(QueryBuilder.prototype).map(describe('query')),
    },
    ...schemas.filter((ns) => ns?.name !== 'query'),
  ];
}

export async function schemaCommand(args: string[]): Promise<void> {
  const compact = hasFlag(args, '--compact');

  // Dynamically import the bridge schema to get tool definitions
  let schemas: any[];
  try {
    const mod = await import('@ifc-lite/sandbox/schema');
    // The import succeeding does not mean the export is usable. A partial or
    // skewed `dist/` can resolve the module with `NAMESPACE_SCHEMAS` absent
    // (`undefined` under Node ESM) or the wrong shape, and `schemas.map(...)`
    // below runs OUTSIDE this try — so without the check the command dies on
    // an uncaught TypeError with no fallback, no warning and no exit code,
    // which is a worse outcome than the silence this command was fixed for.
    // Throwing here routes it through the catch that already does all three.
    if (!Array.isArray(mod.NAMESPACE_SCHEMAS)) {
      throw new TypeError(
        `NAMESPACE_SCHEMAS is ${mod.NAMESPACE_SCHEMAS === undefined ? 'missing' : 'not an array'}`,
      );
    }
    schemas = mod.NAMESPACE_SCHEMAS;
  } catch (err) {
    // Fallback: a small hand-maintained subset of the real schema. Callers
    // of `ifc-lite schema` are usually LLM tools discovering the API — being
    // handed a truncated namespace list that looks authoritative is worse
    // than being told the load failed, so say so on stderr (stdout stays
    // pure JSON).
    process.stderr.write(
      `Warning: could not load the full SDK schema from @ifc-lite/sandbox/schema ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `emitting a reduced built-in schema that omits namespaces and methods.\n`,
    );
    schemas = getStaticSchema();
    // stderr is the one channel a `schema | jq` pipeline routinely discards;
    // a non-zero exit is the signal such a caller can't ignore without
    // opting out of error handling altogether. stdout stays pure JSON.
    process.exitCode = 1;
  }

  const output = withRuntimeQueryShape(schemas).map(ns => ({
    namespace: ns.name,
    description: ns.doc,
    methods: ns.methods.map((m: any) => {
      const entry: Record<string, unknown> = {
        name: m.name,
        description: m.doc,
      };
      if (!compact) {
        if (m.paramNames) entry.params = m.paramNames;
        if (m.tsReturn) entry.returns = m.tsReturn;
        if (m.llmSemantics?.useWhen) entry.useWhen = m.llmSemantics.useWhen;
        if (m.llmSemantics?.taskTags) entry.taskTags = m.llmSemantics.taskTags;
      }
      return entry;
    }),
  }));

  printJson(output);
}

function getStaticSchema(): any[] {
  return [
    {
      name: 'model', doc: 'Model operations',
      methods: [
        { name: 'list', doc: 'List loaded models' },
        { name: 'active', doc: 'Get active model' },
        { name: 'activeId', doc: 'Get active model ID' },
      ],
    },
    // No `query` entry: `withRuntimeQueryShape` reflects the `bim` root and
    // the query-builder chain off the SDK classes, on the fallback path too,
    // so a hand-written copy here could only rot (and the one that used to
    // live here documented the sandbox bridge's `bim.query.*`, #3763).
    {
      name: 'export', doc: 'Multi-format export',
      methods: [
        { name: 'csv', doc: 'Export to CSV', paramNames: ['entities', 'options'] },
        { name: 'json', doc: 'Export to JSON', paramNames: ['entities', 'columns'] },
        { name: 'ifc', doc: 'Export to IFC STEP', paramNames: ['entities', 'options'] },
      ],
    },
    {
      name: 'ids', doc: 'IDS validation',
      methods: [
        { name: 'parse', doc: 'Parse IDS XML document', paramNames: ['xmlContent'] },
        { name: 'validate', doc: 'Validate against IFC model', paramNames: ['idsDocument', 'options'] },
        { name: 'summarize', doc: 'Summarize validation report', paramNames: ['report'] },
      ],
    },
    {
      name: 'bcf', doc: 'BCF collaboration',
      methods: [
        { name: 'createProject', doc: 'Create BCF project', paramNames: ['options'] },
        { name: 'createTopic', doc: 'Create topic/issue', paramNames: ['options'] },
        { name: 'createComment', doc: 'Create comment', paramNames: ['options'] },
        { name: 'read', doc: 'Read BCF file', paramNames: ['data'] },
        { name: 'write', doc: 'Write BCF file', paramNames: ['project'] },
      ],
    },
    {
      name: 'create', doc: 'IFC creation',
      methods: [
        { name: 'project', doc: 'Create new IFC project', paramNames: ['params'] },
        { name: 'building', doc: 'Create project with one storey', paramNames: ['params'] },
      ],
    },
  ];
}
