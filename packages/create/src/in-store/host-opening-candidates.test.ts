// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from 'vitest';
import { hostOpeningCandidates } from './host-opening-candidates.js';
import { readHostOpeningExtents } from './hosted-element.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { newStorey } from './wall-join-mesh.oracle.js';

async function sourceOverride() {
  const s = await newStorey();
  const id = s.store.entityIndex.byType.get('IFCRELAGGREGATES')![0]!;
  s.view.setPositionalAttribute(id, 5, [`#${s.storeyId}`]);
  return { ...s, id };
}

it('#8452 rejects unrelated source override classes without resolving their payload', async () => {
  const s = await sourceOverride();
  const reads = vi.spyOn(AnchorEntityReader.prototype, 'entity');
  try {
    expect([...hostOpeningCandidates(s.store, 777, s.view)]).toEqual([]);
    expect(reads.mock.calls.filter(([id]) => id === s.id)).toHaveLength(0);
  } finally { reads.mockRestore(); }
});

it('#8452 retains source relationships retyped into voids and honors deletion', async () => {
  const s = await sourceOverride();
  s.view.setEntityType(s.id, 'IfcRelVoidsElement');
  s.view.setPositionalAttribute(s.id, 4, '#777');
  s.view.setPositionalAttribute(s.id, 5, '#888');
  expect([...hostOpeningCandidates(s.store, 777, s.view)]).toContain(s.id);
  s.view.deleteEntity(s.id);
  expect([...hostOpeningCandidates(s.store, 777, s.view)]).toEqual([]);
});

it('#8452 retains an unreadable host on a retyped source void for conservative refusal', async () => {
  const s = await sourceOverride();
  s.view.setEntityType(s.id, 'IfcRelVoidsElement');
  s.view.setPositionalAttribute(s.id, 4, 'unreadable host');
  expect(readHostOpeningExtents(s.store, 777, s.view).unreadable).toContain(s.id);
});
