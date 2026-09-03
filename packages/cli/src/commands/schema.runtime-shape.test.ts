/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite schema` must describe the `bim` object that `ifc-lite run` and
 * `ifc-lite eval` hand to scripts (#3763).
 *
 * The command used to print `@ifc-lite/sandbox`'s `NAMESPACE_SCHEMAS`
 * verbatim. That schema describes the browser sandbox bridge, where
 * `query.properties(ref)` really is a method. The CLI's `bim` is a raw
 * `BimContext`, where `query()` is a builder-starter and `properties` and its
 * ~20 siblings live at the top level. Every `bim.query.X(...)` call an agent
 * copied out of the schema dump threw `TypeError: ... is not a function`.
 *
 * This test walks the DUMP and asserts every documented path resolves on the
 * real runtime object, so the two cannot drift apart again. The runtime is
 * reflected, not transcribed: a new `BimContext` method that nothing
 * documents fails here too.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { BimContext, QueryBuilder } from '@ifc-lite/sdk';
import { schemaCommand } from './schema.js';

afterEach(() => {
  vi.restoreAllMocks();
});

interface DumpedNamespace {
  namespace: string;
  description?: string;
  methods: { name: string }[];
}

async function dumpSchema(): Promise<DumpedNamespace[]> {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const previousExitCode = process.exitCode;
  try {
    await schemaCommand([]);
  } finally {
    process.exitCode = previousExitCode;
  }
  return JSON.parse(out.join('')) as DumpedNamespace[];
}

/** Value-function own property names on a prototype, minus the constructor. */
function prototypeMethods(proto: object): string[] {
  return Object.getOwnPropertyNames(proto).filter((name) => {
    if (name === 'constructor') return false;
    return typeof Object.getOwnPropertyDescriptor(proto, name)?.value === 'function';
  });
}

describe('ifc-lite schema describes the run/eval bim object', () => {
  it('documents the BimContext top-level methods, not a bim.query.* namespace', async () => {
    const dump = await dumpSchema();

    const root = dump.find((ns) => ns.namespace === 'bim');
    expect(root, 'a root `bim` namespace must be documented').toBeDefined();

    const documented = new Set(root!.methods.map((m) => m.name));
    const runtime = prototypeMethods(BimContext.prototype);

    // Every runtime top-level method is documented …
    expect([...runtime].sort()).toEqual([...documented].filter((n) => runtime.includes(n)).sort());
    // … and nothing documented is missing from the runtime.
    expect([...documented].filter((n) => !runtime.includes(n))).toEqual([]);

    // The methods the old dump filed under `query` are the top-level ones.
    for (const name of ['properties', 'quantities', 'entity', 'attributes', 'relationships']) {
      expect(documented.has(name)).toBe(true);
    }
  });

  it('documents the query builder chain, not a flat query namespace', async () => {
    const dump = await dumpSchema();

    const query = dump.find((ns) => ns.namespace === 'query');
    expect(query, 'a `query` namespace must be documented').toBeDefined();

    const documented = query!.methods.map((m) => m.name).sort();
    expect(documented).toEqual(prototypeMethods(QueryBuilder.prototype).sort());

    // The sandbox-bridge-only entries must be gone: on the CLI's `bim` there
    // is no `query.properties`, and `selection` is `bim.viewer.getSelection`.
    for (const name of ['properties', 'quantities', 'selection', 'storeys']) {
      expect(documented).not.toContain(name);
    }
  });

  it('resolves every documented path on a live BimContext', async () => {
    const dump = await dumpSchema();

    // A backend is never called here — only the namespace objects the
    // constructor builds are inspected.
    const bim = new BimContext({ backend: {} as never });

    const unresolved: string[] = [];
    for (const ns of dump) {
      if (ns.namespace === 'bim') {
        for (const m of ns.methods) {
          if (typeof (bim as unknown as Record<string, unknown>)[m.name] !== 'function') {
            unresolved.push(`bim.${m.name}`);
          }
        }
        continue;
      }
      if (ns.namespace === 'query') {
        for (const m of ns.methods) {
          if (typeof (QueryBuilder.prototype as unknown as Record<string, unknown>)[m.name] !== 'function') {
            unresolved.push(`bim.query().${m.name}`);
          }
        }
        continue;
      }
      // `create`'s methods are auto-discovered off `IfcCreator.prototype`, and
      // on the runtime they are reached through the creator `bim.create.project()`
      // returns rather than off `bim.create` itself. That is its own mismatch,
      // not #3763's; only the namespace object is checked here.
      const methods = ns.namespace === 'create' ? [] : ns.methods;
      const target = (bim as unknown as Record<string, unknown>)[ns.namespace];
      if (target == null || (typeof target !== 'object' && typeof target !== 'function')) {
        unresolved.push(`bim.${ns.namespace}`);
        continue;
      }
      for (const m of methods) {
        if (typeof (target as Record<string, unknown>)[m.name] !== 'function') {
          unresolved.push(`bim.${ns.namespace}.${m.name}`);
        }
      }
    }

    expect(unresolved).toEqual([]);
  });
});
