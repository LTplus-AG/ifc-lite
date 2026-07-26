/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-surface freeze pin for node-hash-v0 (FROZEN 2026-07-25, spec version
 * node-hash-v0 / 1.0.0, docs/vision/spec/node-hash-v0.md).
 *
 * Two things beyond the per-kind golden vectors must stay byte-stable under
 * the node-hash-v0 freeze:
 *
 * 1. `CERTIFICATE_VERSION` — the `version` string a serialized node-hash-v0
 *    certificate carries; verifiers hard-reject anything else, so it is part
 *    of the frozen wire surface.
 * 2. The DAG root (and every node hash) of one canonical mini-model
 *    (`test/golden/mini-model.json`), built through the real `ProvenanceDag`
 *    engine — this pins the whole composed surface (leaf encodings, child-hash
 *    embedding, Merkle propagation, engine dispatch) in one number.
 *
 * A mismatch in either means the node-hash wire format changed; if intentional
 * it requires node-hash-v1 plus a major version bump of @ifc-lite/provenance.
 *
 * `COMMUTATION_CERTIFICATE_VERSION` (`commutation-v0`, `src/commutation.ts`)
 * is pinned SEPARATELY below, under its own change rule. The commutation
 * certificate is a different artifact — a merge-model/epsilon/op-set schema
 * layered on top of node hashes, not part of the node-hash-v0 wire format —
 * so it may advance to `commutation-v1` on its own, WITHOUT requiring
 * node-hash-v1. Its pin exists to make that step deliberate, not to couple the
 * two formats.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_VERSION,
  COMMUTATION_CERTIFICATE_VERSION,
  createCertificate,
  ProvenanceDag,
  type GeometryMeshPayload,
  type PropertySetPayload,
} from '../src/index.js';

const FREEZE_POLICY =
  'node-hash-v0 wire format is FROZEN (1.0.0, 2026-07-25 — docs/vision/spec/node-hash-v0.md). ' +
  'If this change is intentional it requires node-hash-v1: a new versioned spec file plus a ' +
  'major version bump of @ifc-lite/provenance.';

/** The commutation certificate versions independently of node-hash: it is a
 *  separate schema (merge model, epsilon, op sets) layered ON TOP of node
 *  hashes, so advancing it must never drag the node-hash format with it. */
const COMMUTATION_POLICY =
  'commutation-v0 is the pinned commutation-certificate schema version ' +
  '(packages/provenance/src/commutation.ts). It versions INDEPENDENTLY of node-hash-v0: ' +
  'evolving it means introducing commutation-v1 and updating this pin — it does NOT require ' +
  'node-hash-v1, and it does not by itself change the node-hash wire format.';

interface MiniModelComponentRef {
  componentKey: string;
  child: string;
}

interface MiniModelRoleRef {
  roleName: string;
  children: string[];
}

interface MiniModelNode {
  id: string;
  kind: 'geometry-mesh' | 'property-set' | 'relationship' | 'layer' | 'element';
  payload?: GeometryMeshPayload | PropertySetPayload;
  composite?: {
    key?: string;
    ifcType?: string;
    components?: MiniModelComponentRef[];
    relType?: string;
    roles?: MiniModelRoleRef[];
    layerId?: string;
    children?: string[];
  };
}

interface MiniModelFixture {
  description: string;
  rootId: string;
  nodes: MiniModelNode[];
  expectedHashes: Record<string, string>;
  expectedRootHash: string;
}

function requireHash(childHashes: ReadonlyMap<string, string>, id: string): string {
  const hash = childHashes.get(id);
  if (hash === undefined) throw new Error(`mini-model: missing child hash for "${id}"`);
  return hash;
}

function addNode(dag: ProvenanceDag, node: MiniModelNode): void {
  if (node.payload !== undefined) {
    if (node.kind === 'geometry-mesh') {
      dag.addNode({ id: node.id, kind: 'geometry-mesh', payload: node.payload as GeometryMeshPayload });
    } else if (node.kind === 'property-set') {
      dag.addNode({ id: node.id, kind: 'property-set', payload: node.payload as PropertySetPayload });
    } else {
      throw new Error(`mini-model: unexpected leaf kind "${node.kind}"`);
    }
    return;
  }
  const c = node.composite;
  if (!c) throw new Error(`mini-model: node "${node.id}" has neither payload nor composite`);
  if (node.kind === 'element') {
    const components = c.components ?? [];
    dag.addNode({
      id: node.id,
      kind: 'element',
      children: components.map((m) => m.child),
      buildPayload: (childHashes) => ({
        key: c.key ?? '',
        ifcType: c.ifcType ?? '',
        components: components.map((m) => ({
          componentKey: m.componentKey,
          hash: requireHash(childHashes, m.child),
        })),
      }),
    });
  } else if (node.kind === 'relationship') {
    const roles = c.roles ?? [];
    dag.addNode({
      id: node.id,
      kind: 'relationship',
      children: roles.flatMap((r) => r.children),
      buildPayload: (childHashes) => ({
        relType: c.relType ?? '',
        roles: roles.map((r) => ({
          roleName: r.roleName,
          refs: r.children.map((id) => requireHash(childHashes, id)),
        })),
      }),
    });
  } else if (node.kind === 'layer') {
    const children = c.children ?? [];
    dag.addNode({
      id: node.id,
      kind: 'layer',
      children,
      buildPayload: (childHashes) => ({
        layerId: c.layerId ?? '',
        childHashes: children.map((id) => requireHash(childHashes, id)),
      }),
    });
  } else {
    throw new Error(`mini-model: unexpected composite kind "${node.kind}"`);
  }
}

function loadMiniModel(): MiniModelFixture {
  const raw = readFileSync(new URL('./golden/mini-model.json', import.meta.url), 'utf8');
  return JSON.parse(raw) as MiniModelFixture;
}

describe('node-hash-v0 frozen cross-surface pin', () => {
  it('pins the node-hash certificate serialization version string', () => {
    expect(CERTIFICATE_VERSION, FREEZE_POLICY).toBe('node-hash-v0');

    // The version constant is what actually lands in a serialized certificate.
    const certificate = createCertificate({
      kernelVersion: 'test-kernel',
      trustRoot: 'fnv1a64:0x0000000000000000',
      reads: [],
      writes: [],
      claims: [],
    });
    expect(certificate.version, FREEZE_POLICY).toBe('node-hash-v0');
    const serialized = JSON.parse(JSON.stringify(certificate)) as { version: string };
    expect(serialized.version, FREEZE_POLICY).toBe('node-hash-v0');
  });

  it('pins the DAG root and every node hash of the canonical mini-model', async () => {
    const fixture = loadMiniModel();
    const dag = new ProvenanceDag();
    for (const node of fixture.nodes) addNode(dag, node);
    await dag.build();

    for (const [nodeId, expected] of Object.entries(fixture.expectedHashes)) {
      expect(
        dag.getHash(nodeId),
        `Mini-model node "${nodeId}" drifted. ${FREEZE_POLICY}`,
      ).toBe(expected);
    }
    expect(
      dag.getHash(fixture.rootId),
      `Mini-model DAG root drifted. ${FREEZE_POLICY}`,
    ).toBe(fixture.expectedRootHash);
  });
});

describe('commutation certificate version pin (independent of node-hash-v0)', () => {
  it('pins commutation-v0 under its own change rule', () => {
    expect(COMMUTATION_CERTIFICATE_VERSION, COMMUTATION_POLICY).toBe('commutation-v0');
  });
});
