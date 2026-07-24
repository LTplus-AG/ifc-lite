/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  computeNodeHash,
  createCertificate,
  verifyCertificate,
  type Certificate,
  type GeometryMeshPayload,
  type NodeResolver,
  type PropertySetPayload,
  type ResolvedNode,
} from './index.js';

const KERNEL_VERSION = 'ifc-lite-geometry@0.0.0-test';
const TRUST_ROOT = 'fnv1a64:0xfeedfacefeedface';

function wallMesh(x: number): GeometryMeshPayload {
  return {
    expressId: 500,
    geometryClass: 0,
    positions: [0, 0, 0, x, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    origin: [0, 0, 0],
  };
}

function pset(value: number): PropertySetPayload {
  return { name: 'Pset_WallCommon', properties: [{ name: 'ThermalTransmittance', value }] };
}

/** In-memory resolver over a fixed `nodeId -> ResolvedNode` map — the shape
 *  any real adapter (viewer store, CLI, collab doc) would supply. */
function resolverFromMap(map: ReadonlyMap<string, ResolvedNode>): NodeResolver {
  return async (nodeId: string) => map.get(nodeId);
}

describe('createCertificate + verifyCertificate: round trip', () => {
  it('passes when every ref and claim matches the resolver', async () => {
    const meshBefore = wallMesh(1);
    const meshAfter = wallMesh(1); // unchanged in this scenario
    const hashBefore = await computeNodeHash('geometry-mesh', meshBefore);
    const hashAfter = await computeNodeHash('geometry-mesh', meshAfter);
    expect(hashBefore).toBe(hashAfter);

    const cert = createCertificate({
      kernelVersion: KERNEL_VERSION,
      trustRoot: TRUST_ROOT,
      reads: [{ nodeId: 'wall/500', hash: hashBefore }],
      writes: [{ nodeId: 'wall/500', hash: hashAfter }],
      claims: [
        { type: 'subtree-untouched', nodes: [{ nodeId: 'wall/500', hash: hashAfter }] },
        {
          type: 'scalar-delta',
          metric: 'ThermalTransmittance',
          before: 0.24,
          after: 0.24,
          delta: 0,
        },
      ],
    });

    const resolver = resolverFromMap(
      new Map([['wall/500', { kind: 'geometry-mesh', payload: meshAfter }]]),
    );

    const result = await verifyCertificate(cert, resolver, {
      expectedTrustRoot: TRUST_ROOT,
      expectedKernelVersion: KERNEL_VERSION,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('verifyCertificate: trust root / kernel version', () => {
  it('fails on a trust-root mismatch before touching the resolver', async () => {
    const mesh = wallMesh(1);
    const hash = await computeNodeHash('geometry-mesh', mesh);
    const cert = createCertificate({
      kernelVersion: KERNEL_VERSION,
      trustRoot: TRUST_ROOT,
      reads: [{ nodeId: 'a', hash }],
      writes: [],
      claims: [],
    });

    let resolverCalled = false;
    const resolver: NodeResolver = async () => {
      resolverCalled = true;
      return { kind: 'geometry-mesh', payload: mesh };
    };

    const result = await verifyCertificate(cert, resolver, { expectedTrustRoot: 'fnv1a64:0xdifferent' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('trust-root-mismatch');
    expect(resolverCalled).toBe(false);
  });

  it('fails on a kernel-version mismatch', async () => {
    const mesh = wallMesh(1);
    const hash = await computeNodeHash('geometry-mesh', mesh);
    const cert = createCertificate({
      kernelVersion: KERNEL_VERSION,
      trustRoot: TRUST_ROOT,
      reads: [{ nodeId: 'a', hash }],
      writes: [],
      claims: [],
    });
    const result = await verifyCertificate(cert, resolverFromMap(new Map()), {
      expectedKernelVersion: 'ifc-lite-geometry@9.9.9',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('kernel-version-mismatch');
  });
});

describe('verifyCertificate: tampered payload (any claim type) is caught via reads/writes', () => {
  it('fails when the resolved payload no longer matches the declared hash', async () => {
    const original = wallMesh(1);
    const hash = await computeNodeHash('geometry-mesh', original);
    const cert = createCertificate({
      kernelVersion: KERNEL_VERSION,
      trustRoot: TRUST_ROOT,
      reads: [{ nodeId: 'wall/500', hash }],
      writes: [],
      claims: [],
    });

    // The resolver now serves a mutated mesh under the same node id — as if
    // an attacker (or a bug) rewrote the geometry after the certificate was
    // minted.
    const tampered = wallMesh(999);
    const resolver = resolverFromMap(
      new Map([['wall/500', { kind: 'geometry-mesh', payload: tampered }]]),
    );

    const result = await verifyCertificate(cert, resolver);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('hash-mismatch');
      expect((result.details as { nodeId: string }).nodeId).toBe('wall/500');
    }
  });
});

describe('verifyCertificate: subtree-untouched claim', () => {
  it('passes when the claimed subtree really is unchanged', async () => {
    const mesh = wallMesh(1);
    const hash = await computeNodeHash('geometry-mesh', mesh);
    const cert = createCertificate({
      kernelVersion: KERNEL_VERSION,
      trustRoot: TRUST_ROOT,
      reads: [],
      writes: [],
      claims: [{ type: 'subtree-untouched', nodes: [{ nodeId: 'wall/500', hash }] }],
    });
    const resolver = resolverFromMap(new Map([['wall/500', { kind: 'geometry-mesh', payload: mesh }]]));
    expect(await verifyCertificate(cert, resolver)).toEqual({ ok: true });
  });

  it('tamper: fails when the underlying payload actually changed', async () => {
    const mesh = wallMesh(1);
    const hash = await computeNodeHash('geometry-mesh', mesh);
    const cert = createCertificate({
      kernelVersion: KERNEL_VERSION,
      trustRoot: TRUST_ROOT,
      reads: [],
      writes: [],
      claims: [{ type: 'subtree-untouched', nodes: [{ nodeId: 'wall/500', hash }] }],
    });
    // The claim says wall/500 is unchanged, but the "current" state moved it.
    const resolver = resolverFromMap(
      new Map([['wall/500', { kind: 'geometry-mesh', payload: wallMesh(2) }]]),
    );
    const result = await verifyCertificate(cert, resolver);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('hash-mismatch');
  });

  it('tamper: fails when the claim itself is forged with a hash that never existed', async () => {
    const mesh = wallMesh(1);
    const cert = createCertificate({
      kernelVersion: KERNEL_VERSION,
      trustRoot: TRUST_ROOT,
      reads: [],
      writes: [],
      claims: [{ type: 'subtree-untouched', nodes: [{ nodeId: 'wall/500', hash: 'fnv1a64:0xdeadbeefdeadbeef' }] }],
    });
    const resolver = resolverFromMap(new Map([['wall/500', { kind: 'geometry-mesh', payload: mesh }]]));
    const result = await verifyCertificate(cert, resolver);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('hash-mismatch');
  });
});

describe('verifyCertificate: hash-equality claim', () => {
  it('passes when two distinct nodes genuinely share one hash', async () => {
    const doorA = wallMesh(1);
    const doorB = wallMesh(1); // same content, different node id (e.g. two repeated doors)
    const hash = await computeNodeHash('geometry-mesh', doorA);
    const cert = createCertificate({
      kernelVersion: KERNEL_VERSION,
      trustRoot: TRUST_ROOT,
      reads: [],
      writes: [],
      claims: [{ type: 'hash-equality', a: { nodeId: 'door/1', hash }, b: { nodeId: 'door/2', hash } }],
    });
    const resolver = resolverFromMap(
      new Map([
        ['door/1', { kind: 'geometry-mesh', payload: doorA }],
        ['door/2', { kind: 'geometry-mesh', payload: doorB }],
      ]),
    );
    expect(await verifyCertificate(cert, resolver)).toEqual({ ok: true });
  });

  it('tamper: fails when the two nodes actually differ (claim forged, hashes not equal to each other)', async () => {
    const doorA = wallMesh(1);
    const doorB = wallMesh(2);
    const hashA = await computeNodeHash('geometry-mesh', doorA);
    const hashB = await computeNodeHash('geometry-mesh', doorB);
    const cert = createCertificate({
      kernelVersion: KERNEL_VERSION,
      trustRoot: TRUST_ROOT,
      reads: [],
      writes: [],
      claims: [
        { type: 'hash-equality', a: { nodeId: 'door/1', hash: hashA }, b: { nodeId: 'door/2', hash: hashB } },
      ],
    });
    const resolver = resolverFromMap(
      new Map([
        ['door/1', { kind: 'geometry-mesh', payload: doorA }],
        ['door/2', { kind: 'geometry-mesh', payload: doorB }],
      ]),
    );
    const result = await verifyCertificate(cert, resolver);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('claim-hash-equality-not-equal');
  });

  it('tamper: fails when one side was rewritten after the certificate was minted', async () => {
    const doorA = wallMesh(1);
    const doorB = wallMesh(1);
    const hash = await computeNodeHash('geometry-mesh', doorA);
    const cert = createCertificate({
      kernelVersion: KERNEL_VERSION,
      trustRoot: TRUST_ROOT,
      reads: [],
      writes: [],
      claims: [{ type: 'hash-equality', a: { nodeId: 'door/1', hash }, b: { nodeId: 'door/2', hash } }],
    });
    // door/2 has since been moved — the resolver reflects that, the claim doesn't.
    const resolver = resolverFromMap(
      new Map([
        ['door/1', { kind: 'geometry-mesh', payload: doorA }],
        ['door/2', { kind: 'geometry-mesh', payload: wallMesh(3) }],
      ]),
    );
    const result = await verifyCertificate(cert, resolver);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('hash-mismatch');
  });
});

describe('verifyCertificate: scalar-delta claim', () => {
  it('passes when the arithmetic and the referenced nodes agree', async () => {
    const cert = createCertificate({
      kernelVersion: KERNEL_VERSION,
      trustRoot: TRUST_ROOT,
      reads: [],
      writes: [],
      claims: [
        {
          type: 'scalar-delta',
          metric: 'ThermalTransmittance',
          before: 0.3,
          after: 0.24,
          delta: -0.06,
          beforeNodeId: 'wall/500#before',
          afterNodeId: 'wall/500#after',
        },
      ],
    });
    const resolver = resolverFromMap(
      new Map([
        ['wall/500#before', { kind: 'property-set', payload: pset(0.3) }],
        ['wall/500#after', { kind: 'property-set', payload: pset(0.24) }],
      ]),
    );
    expect(await verifyCertificate(cert, resolver)).toEqual({ ok: true });
  });

  it('tamper: fails when delta does not equal after - before (forged claim)', async () => {
    const cert = createCertificate({
      kernelVersion: KERNEL_VERSION,
      trustRoot: TRUST_ROOT,
      reads: [],
      writes: [],
      claims: [
        { type: 'scalar-delta', metric: 'Volume', before: 10, after: 12, delta: 999 },
      ],
    });
    const result = await verifyCertificate(cert, resolverFromMap(new Map()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('claim-scalar-delta-arithmetic');
  });

  it('tamper: fails when the referenced "after" payload does not actually show the claimed value', async () => {
    const cert = createCertificate({
      kernelVersion: KERNEL_VERSION,
      trustRoot: TRUST_ROOT,
      reads: [],
      writes: [],
      claims: [
        {
          type: 'scalar-delta',
          metric: 'ThermalTransmittance',
          before: 0.3,
          after: 0.24,
          delta: -0.06,
          beforeNodeId: 'wall/500#before',
          afterNodeId: 'wall/500#after',
        },
      ],
    });
    const resolver = resolverFromMap(
      new Map([
        ['wall/500#before', { kind: 'property-set', payload: pset(0.3) }],
        // The real data disagrees with the claimed "after" value.
        ['wall/500#after', { kind: 'property-set', payload: pset(0.5) }],
      ]),
    );
    const result = await verifyCertificate(cert, resolver);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('claim-scalar-delta-after-mismatch');
  });
});

describe('createCertificate structural validation', () => {
  it('rejects an untagged hash', () => {
    expect(() =>
      createCertificate({
        kernelVersion: KERNEL_VERSION,
        trustRoot: TRUST_ROOT,
        reads: [{ nodeId: 'a', hash: 'not-tagged' }],
        writes: [],
        claims: [],
      }),
    ).toThrow(/untagged hash/);
  });
});

