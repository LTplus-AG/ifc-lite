/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A Script node that reaches the network must not be served from the memo
 * on a rerun (#5634): the response is the world outside the graph, and the
 * memo key (code, inputs, model revision) cannot see it change. A Script
 * that never calls `bim.network.fetch` stays memoised, grant or no grant.
 *
 * Runs the production path: the real scheduler, the real `script.run`, the
 * real QuickJS sandbox and the real grant check. Only the transport is
 * substituted, and it is only reached after the allow-list check passes.
 */

import { describe, expect, it } from 'vitest';
import { parseCapabilities } from '@ifc-lite/extensions';
import { MemoCache, runFlow, type FlowDocument } from '@ifc-lite/flow';
import type { FetchTransport } from '@ifc-lite/sandbox';
import { createStandardRegistry, type FlowHost } from './index.js';
import { createFakeBim } from './__tests__/fake-backend.js';

const registry = createStandardRegistry();

function grantsFor(capabilities: readonly string[]) {
  const parsed = parseCapabilities(capabilities);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
}

/** A transport that answers each request with a fresh counter value. */
function countingTransport(calls: string[]): FetchTransport {
  return async (url) => {
    calls.push(url.href);
    return new Response(`response ${calls.length}`, { status: 200 });
  };
}

/** One Script node; with `lanes`, a literal list on `a` lifts it to one run per element. */
function graph(code: string, lanes?: readonly number[]): FlowDocument {
  return {
    flowVersion: 1, id: 'g', name: 'g', capabilities: ['model.read', 'network.fetch:api.example.com'], inputs: [],
    outputs: [{ nodeId: 's', port: 'result', label: 'result' }],
    nodes: [
      ...(lanes ? [{ id: 'l', type: 'core.list', params: { items: lanes } }] : []),
      { id: 's', type: 'script.run', params: { code, timeoutMs: 10_000 } },
    ],
    edges: lanes ? [{ from: ['l', 'items'], to: ['s', 'a'] }] : [],
  };
}

async function runTwice(code: string, networkGrants: readonly string[], lanes?: readonly number[]) {
  const calls: string[] = [];
  const host: FlowHost = {
    bim: createFakeBim().bim,
    networkGrants: grantsFor(networkGrants),
    networkTransport: countingTransport(calls),
  };
  const cache = new MemoCache();
  const first = await runFlow(graph(code, lanes), { host, registry, cache });
  const second = await runFlow(graph(code, lanes), { host, registry, cache });
  const script = (r: typeof first) => r.reports.find((report) => report.nodeId === 's');
  return { calls, first, second, script };
}

/** The graph's single output as a whole-value `item`, or a marker when it is some other shape. */
function result(run: Awaited<ReturnType<typeof runFlow>>): unknown {
  const data = run.graphOutputs[0].data;
  return data?.kind === 'item' ? data.value : { notAnItem: data };
}

const FETCHING = 'bim.network.fetch("https://api.example.com/v1").then((r) => r.body)';

describe('script.run memoisation when the script uses the network (#5634)', () => {
  it('fetches again on a rerun with the same MemoCache instead of replaying the first response', async () => {
    const { calls, first, second } = await runTwice(FETCHING, ['network.fetch:api.example.com']);
    // A script ending in a promise yields the sandbox's settled-promise dump.
    expect(result(first)).toEqual({ type: 'fulfilled', value: 'response 1' });
    expect(calls).toEqual(['https://api.example.com/v1', 'https://api.example.com/v1']);
    expect(second.reports[0].status).toBe('ok');
    expect(result(second)).toEqual({ type: 'fulfilled', value: 'response 2' });
  });

  it('does not memoise a lifted run in which one lane fetched and then threw', async () => {
    // Lane 2's error becomes a null lane and the node still reports `ok`, so
    // without the check the whole result, null included, was memoised.
    const code = 'inputs.a === 2 ? bim.network.fetch("https://api.example.com/v1").then(() => { throw new Error("bad payload"); }) : inputs.a';
    const { calls, first, second, script } = await runTwice(code, ['network.fetch:api.example.com'], [1, 2]);
    expect(script(first)?.laneErrors).toBe(1);
    expect(calls).toHaveLength(2);
    expect(script(second)?.status).toBe('ok');
    expect(script(second)?.laneErrors).toBe(1);
  });

  it('still serves a script that never calls the network from the memo, even in a graph holding a grant', async () => {
    const { calls, first, second } = await runTwice('bim.query.byType("IfcWall").length', ['network.fetch:api.example.com']);
    expect(result(first)).toBe(3);
    expect(calls).toEqual([]);
    expect(second.reports[0].status).toBe('memo');
    expect(result(second)).toBe(3);
  });

  it('still serves a pure script from the memo when the graph holds no network grant', async () => {
    const { second } = await runTwice('40 + 2', []);
    expect(second.reports[0].status).toBe('memo');
    expect(result(second)).toBe(42);
  });
});
