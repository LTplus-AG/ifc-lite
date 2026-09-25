/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `nodeAvailability` / `checkAvailability` — the network/secrets half
 * (#5167 phases 3.3/3.5). The backend/noop behaviour predates this change;
 * these tests focus on what phase 3.3/3.5 wiring depends on: a missing
 * `network` bridge or a missing declared secret is always `unavailable`,
 * never `noop` — silently skipping a node that was supposed to fetch data
 * or read a secret would hand a downstream node `undefined` instead of a
 * clear "this cannot run here".
 */

import { describe, expect, it } from 'vitest';
import { NodeRegistry, type NodeDef } from './registry.js';
import { checkAvailability, nodeAvailability, type HostFeatures } from './availability.js';
import type { FlowDocument } from './document.js';

function def(type: string, requires: NodeDef['requires']): NodeDef {
  return {
    type,
    title: type,
    category: 'test',
    inputs: [],
    outputs: [],
    params: [],
    capabilities: [],
    requires,
    run: () => ({}),
  };
}

const NO_NETWORK: HostFeatures = { backend: new Set(), network: false, secrets: new Set() };
const WITH_NETWORK: HostFeatures = { backend: new Set(), network: true, secrets: new Set() };

describe('nodeAvailability — network', () => {
  it('is unavailable, not noop, when the host has no network bridge', () => {
    const d = def('http.request', { network: true });
    const { status, reasons } = nodeAvailability(d, 'http.request', NO_NETWORK);
    expect(status).toBe('unavailable');
    expect(reasons).toEqual(['no network bridge on this host']);
  });

  it('is ok when the host has a network bridge', () => {
    const d = def('http.request', { network: true });
    const { status } = nodeAvailability(d, 'http.request', WITH_NETWORK);
    expect(status).toBe('ok');
  });

  it('a node with no network requirement is unaffected by the host lacking one', () => {
    const d = def('core.number', {});
    const { status } = nodeAvailability(d, 'core.number', NO_NETWORK);
    expect(status).toBe('ok');
  });
});

describe('nodeAvailability — secrets', () => {
  it('is unavailable when a required secret is not in the host secret set', () => {
    const d = def('http.request', { secrets: ['API_TOKEN'] });
    const { status, reasons } = nodeAvailability(d, 'http.request', { backend: new Set(), network: true, secrets: new Set() });
    expect(status).toBe('unavailable');
    expect(reasons).toEqual(['secret "API_TOKEN" is not available on this host']);
  });

  it('is ok when every required secret is present', () => {
    const d = def('http.request', { secrets: ['API_TOKEN'] });
    const { status } = nodeAvailability(d, 'http.request', { backend: new Set(), network: true, secrets: new Set(['API_TOKEN']) });
    expect(status).toBe('ok');
  });

  it('an empty host secret set (the viewer) makes any secret-requiring node unavailable', () => {
    const d = def('http.request', { secrets: ['API_TOKEN'] });
    const { status } = nodeAvailability(d, 'http.request', { backend: new Set(), network: true, secrets: new Set() });
    expect(status).toBe('unavailable');
  });

  it('never reports noop for a missing secret, even when the node declares headless: noop', () => {
    const d: NodeDef = { ...def('http.request', { secrets: ['API_TOKEN'] }), headless: 'noop' };
    const { status } = nodeAvailability(d, 'http.request', { backend: new Set(), network: true, secrets: new Set() });
    expect(status).toBe('unavailable');
  });
});

describe('checkAvailability — whole-document report', () => {
  it('reports each node by id with its own status', () => {
    const registry = new NodeRegistry().registerAll([
      def('http.request', { network: true }),
      def('core.number', {}),
    ]);
    const doc: FlowDocument = {
      flowVersion: 1, id: 'g', name: 'g', capabilities: [], inputs: [], outputs: [],
      nodes: [
        { id: 'a', type: 'http.request' },
        { id: 'b', type: 'core.number' },
      ],
      edges: [],
    };
    const report = checkAvailability(doc, registry, NO_NETWORK);
    expect(report).toEqual([
      { nodeId: 'a', type: 'http.request', status: 'unavailable', reasons: ['no network bridge on this host'] },
      { nodeId: 'b', type: 'core.number', status: 'ok', reasons: [] },
    ]);
  });
});

describe('checkAvailability — secrets referenced in params (#5446 review)', () => {
  const registry = new NodeRegistry().registerAll([def('http.request', { network: true }), def('core.number', {})]);
  const graph: FlowDocument = {
    flowVersion: 1, id: 'g', name: 'g', capabilities: ['secret.read:API_TOKEN'], inputs: [], outputs: [],
    nodes: [
      { id: 'a', type: 'http.request', params: { headers: { Authorization: 'Bearer {{secret:API_TOKEN}}' } } },
      { id: 'b', type: 'core.number' },
    ],
    edges: [],
  };

  it('reports a node whose params reference a secret the host lacks as unavailable', () => {
    // The node TYPE requires no secret; only this instance's params do. Seeing
    // only `def.requires`, `flow validate` called the graph runnable and the
    // run then failed its own secret preflight.
    expect(checkAvailability(graph, registry, WITH_NETWORK)).toEqual([
      { nodeId: 'a', type: 'http.request', status: 'unavailable', reasons: ['secret "API_TOKEN" is not available on this host'] },
      { nodeId: 'b', type: 'core.number', status: 'ok', reasons: [] },
    ]);
  });

  it('is ok once the host has the secret', () => {
    const features: HostFeatures = { ...WITH_NETWORK, secrets: new Set(['API_TOKEN']) };
    expect(checkAvailability(graph, registry, features).map((n) => n.status)).toEqual(['ok', 'ok']);
  });

  it('is unavailable for an UNDECLARED secret even when the host has it, as the run refuses it', () => {
    const features: HostFeatures = { ...WITH_NETWORK, secrets: new Set(['API_TOKEN']) };
    const undeclared: FlowDocument = { ...graph, capabilities: [] };
    expect(checkAvailability(undeclared, registry, features)[0]).toEqual({
      nodeId: 'a', type: 'http.request', status: 'unavailable',
      reasons: ['secret "API_TOKEN" is referenced but the graph does not declare secret.read:API_TOKEN'],
    });
  });
});
