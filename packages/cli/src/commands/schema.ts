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
 */
const RUNTIME_METHOD_DOCS: Record<string, string> = {
  query: 'Start a query chain: bim.query().byType(...).toArray()',
  model: 'Restrict the chain to one model',
  byType: "Filter by IFC type e.g. 'IfcWall'",
  where: 'Filter by a property-set value',
  limit: 'Cap the number of results',
  offset: 'Skip the first n results',
  toArray: 'Run the chain and return the entities',
  first: 'Run the chain and return the first entity, or null',
  count: 'Run the chain and return the number of matches',
  refs: 'Run the chain and return entity refs only',
};

/** Own value-function property names on a prototype, minus the constructor. */
function prototypeMethods(proto: object): string[] {
  return Object.getOwnPropertyNames(proto).filter((name) => {
    if (name === 'constructor') return false;
    return typeof Object.getOwnPropertyDescriptor(proto, name)?.value === 'function';
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
 * transcribed, so this cannot drift from the runtime. Docs and parameter names
 * are carried over from the bridge schema by name where it has them.
 */
function withRuntimeQueryShape(schemas: any[]): any[] {
  const bridgeQuery = schemas.find((ns) => ns?.name === 'query');
  const bridgeMethods = new Map<string, any>(
    (bridgeQuery?.methods ?? []).map((m: any) => [m.name, m]),
  );

  const describe = (name: string) => {
    const fromBridge = bridgeMethods.get(name);
    return {
      ...(fromBridge ?? {}),
      name,
      doc: RUNTIME_METHOD_DOCS[name] ?? fromBridge?.doc ?? name,
    };
  };

  return [
    {
      name: 'bim',
      doc: 'Top-level methods on the `bim` object (call as bim.<method>(...))',
      methods: prototypeMethods(BimContext.prototype).map(describe),
    },
    {
      name: 'query',
      doc: 'Query builder chain — start it with bim.query()',
      methods: prototypeMethods(QueryBuilder.prototype).map(describe),
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
