/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcxFile, IfcxNode } from './types.js';
import { IFCLITE_ATTR } from './types.js';
import { composeFederated } from './federated-composition.js';
import { createLayerStack } from './layer-stack.js';
import { createProvenanceManifest, setProvenance } from './provenance.js';
import { findDivergentAttributes, type AttributeOpinions } from './opinions.js';
import { addIfcxOverlay, parseFederatedIfcx } from './index.js';

const FIRE = 'bsi::ifc::prop::FireRating';
const CLASS = { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' } };

function makeFile(data: IfcxNode[], principal?: string): IfcxFile {
  const file: IfcxFile = {
    header: { id: 'test', ifcxVersion: 'ifcx-alpha', dataVersion: '1', author: 'test', timestamp: '2026-10-28T00:00:00Z' },
    imports: [],
    schemas: {},
    data,
  };
  if (!principal) return file;
  return setProvenance(file, createProvenanceManifest({
    author: { kind: 'human', principal },
    intent: 'test layer',
    base: null,
    created: '2026-10-28T00:00:00Z',
  }));
}

/** Later files are stronger (parseFederatedIfcx order). */
function stackOf(files: IfcxFile[]) {
  const stack = createLayerStack();
  files.forEach((file, i) => {
    stack.addLayerAt(file, new ArrayBuffer(0), `layer-${i}`, 0, { type: 'buffer', name: `layer-${i}` });
  });
  return stack;
}

function opinionsByPath(composed: ReturnType<typeof composeFederated>['composed']) {
  const out = new Map<string, AttributeOpinions>();
  for (const [path, node] of composed) if (node.opinions) out.set(path, node.opinions);
  return out;
}

const architect = makeFile([{ path: 'wall-1', attributes: { ...CLASS, [FIRE]: 'EI 60' } }], 'arch@studio.example');
const consultant = makeFile([{ path: 'wall-1', attributes: { [FIRE]: 'EI 90' } }], 'fire@consult.example');

describe('opinion retention (federated composition)', () => {
  it('is off by default: composition keeps no opinions', () => {
    const { composed } = composeFederated(stackOf([architect, consultant]));
    assert.equal(composed.get('wall-1')?.opinions, undefined);
  });

  it('keeps every layer value, weakest first, strongest last = composed value', () => {
    const { composed } = composeFederated(stackOf([architect, consultant]), { retainOpinions: true });
    const wall = composed.get('wall-1');
    assert.ok(wall?.opinions);
    const fire = wall.opinions.get(FIRE);
    assert.deepEqual(fire?.map((o) => [o.layerName, o.principal, o.value]), [
      ['layer-0', 'arch@studio.example', 'EI 60'],
      ['layer-1', 'fire@consult.example', 'EI 90'],
    ]);
    assert.equal(wall.attributes.get(FIRE), fire?.at(-1)?.value, 'last opinion must be the composed value');
  });

  it('lists disagreements, and not agreements', () => {
    const agrees = makeFile([{ path: 'wall-1', attributes: { [FIRE]: 'EI 60' } }]);
    const { composed } = composeFederated(stackOf([architect, agrees, consultant]), { retainOpinions: true });
    const divergent = findDivergentAttributes(opinionsByPath(composed));
    assert.deepEqual(divergent.map((d) => [d.path, d.attribute, d.opinions.length]), [['wall-1', FIRE, 3]]);

    const { composed: agreed } = composeFederated(stackOf([architect, agrees]), { retainOpinions: true });
    assert.deepEqual(findDivergentAttributes(opinionsByPath(agreed)), []);
  });

  it('compares values canonically, not by key order', () => {
    const a = makeFile([{ path: 'wall-1', attributes: { x: { a: 1, b: 2 } } }]);
    const b = makeFile([{ path: 'wall-1', attributes: { x: { b: 2, a: 1 } } }]);
    const { composed } = composeFederated(stackOf([a, b]), { retainOpinions: true });
    assert.equal(composed.get('wall-1')?.opinions?.get('x')?.length, 2);
    assert.deepEqual(findDivergentAttributes(opinionsByPath(composed)), []);
  });

  it('records one opinion per layer: the last node for the path wins within it', () => {
    const twice = makeFile([
      { path: 'wall-1', attributes: { [FIRE]: 'EI 30' } },
      { path: 'wall-1', attributes: { [FIRE]: 'EI 60' } },
    ]);
    const { composed } = composeFederated(stackOf([twice]), { retainOpinions: true });
    assert.deepEqual(composed.get('wall-1')?.opinions?.get(FIRE)?.map((o) => o.value), ['EI 60']);
  });

  it('retains a null removal as an opinion that diverges from a value', () => {
    const removes = makeFile([{ path: 'wall-1', attributes: { [FIRE]: null } }]);
    const { composed } = composeFederated(stackOf([architect, removes]), { retainOpinions: true });
    const wall = composed.get('wall-1');
    assert.equal(wall?.attributes.has(FIRE), false, 'removal still removes the composed value');
    assert.deepEqual(wall?.opinions?.get(FIRE)?.map((o) => o.value), ['EI 60', null]);
    assert.equal(findDivergentAttributes(opinionsByPath(composed)).length, 1);
  });

  it('keeps only own opinions; inherited values stay on the inherited node', () => {
    const typed = makeFile([
      { path: 'wall-type', attributes: { [FIRE]: 'EI 60' } },
      { path: 'wall-1', inherits: { type: 'wall-type' }, attributes: CLASS },
    ]);
    const { composed } = composeFederated(stackOf([typed]), { retainOpinions: true });
    assert.equal(composed.get('wall-1')?.attributes.get(FIRE), 'EI 60', 'inheritance still applies');
    assert.equal(composed.get('wall-1')?.opinions?.has(FIRE), false);
    assert.deepEqual(composed.get('wall-type')?.opinions?.get(FIRE)?.map((o) => o.value), ['EI 60']);
  });

  it('drops opinions of tombstoned nodes with the node', () => {
    const deletes = makeFile([{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } }]);
    const { composed } = composeFederated(stackOf([architect, consultant, deletes]), { retainOpinions: true });
    assert.equal(composed.has('wall-1'), false);
    assert.deepEqual(findDivergentAttributes(opinionsByPath(composed)), []);
  });
});

describe('opinion retention (parse API)', () => {
  const buf = (file: IfcxFile) => new TextEncoder().encode(JSON.stringify(file)).buffer;

  it('returns attributeOpinions only when asked', async () => {
    const files = [{ buffer: buf(architect), name: 'arch.ifcx' }, { buffer: buf(consultant), name: 'fire.ifcx' }];
    const plain = await parseFederatedIfcx(files);
    assert.equal(plain.attributeOpinions, undefined);

    const retained = await parseFederatedIfcx(files, { retainOpinions: true });
    assert.ok(retained.attributeOpinions);
    const divergent = findDivergentAttributes(retained.attributeOpinions);
    assert.deepEqual(divergent.map((d) => [d.path, d.attribute, d.opinions.map((o) => o.layerName)]), [
      ['wall-1', FIRE, ['arch.ifcx', 'fire.ifcx']],
    ]);
  });

  it('keeps retaining across an overlay add', async () => {
    const base = await parseFederatedIfcx([{ buffer: buf(architect), name: 'arch.ifcx' }], { retainOpinions: true });
    assert.deepEqual(findDivergentAttributes(base.attributeOpinions ?? new Map()), []);
    const updated = await addIfcxOverlay(base, buf(consultant), 'fire.ifcx', { retainOpinions: true });
    assert.equal(findDivergentAttributes(updated.attributeOpinions ?? new Map()).length, 1);
  });
});
