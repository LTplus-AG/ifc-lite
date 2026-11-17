// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from 'vitest';
import { CANONICAL_VOID_WALK_LIMIT, hostOpeningCandidates } from './host-opening-candidates.js';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { addHostedElementInStore, readHostOpeningExtents } from './hosted-element.js';
import { addWallToStore } from './wall.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { newStorey } from './wall-join-mesh.oracle.js';

async function sourceOverride() {
  const s = await newStorey();
  const id = s.store.entityIndex.byType.get('IFCRELAGGREGATES')![0]!;
  s.view.setPositionalAttribute(id, 5, [`#${s.storeyId}`]);
  return { ...s, id };
}

/** Authored voids on another host, enough to leave the small canonical walk. */
function crowdVoidClass(s: Awaited<ReturnType<typeof sourceOverride>>): number[] {
  return Array.from({ length: CANONICAL_VOID_WALK_LIMIT + 1 }, (_, i) =>
    s.view.createEntity('IfcRelVoidsElement', [`void-${i}`, null, null, null, '#555', `#${900_000 + i}`]).expressId);
}

it('#10555 walks a small void class canonically, without slot queries or override classification', async () => {
  // Like an authored session's first opening: no voids, one source override.
  const s = await sourceOverride();
  const slots = vi.spyOn(s.view, 'getNewEntityReferenceSlotIds');
  const overrides = vi.spyOn(s.view, 'getAttributeOverrideEntityIds');
  try {
    expect([...hostOpeningCandidates(s.store, 777, s.view)]).toEqual([]);
    expect(slots).not.toHaveBeenCalled();
    expect(overrides).not.toHaveBeenCalled();
  } finally { slots.mockRestore(); overrides.mockRestore(); }
});

it('#10555 hosts a session\'s first windows without reference-slot queries and still refuses overlap', async () => {
  const s = await newStorey();
  const wall = addWallToStore(s.editor, s.anchor, { Start: [0, 0, 0], End: [6, 0, 0], Thickness: 0.2, Height: 3 }).wallId;
  const window = (Offset: number) => addHostedElementInStore(s.store, s.editor, wall, { kind: 'window', params: { Offset, Sill: 0.9, Width: 1, Height: 1.2 } });
  const slots = vi.spyOn(MutablePropertyView.prototype, 'getNewEntityReferenceSlotIds');
  try {
    const first = window(1), second = window(2.5);
    expect(slots).not.toHaveBeenCalled();
    expect(readHostOpeningExtents(s.store, wall, s.view).cuts.map(cut => cut.openingId)).toEqual([first.openingId, second.openingId]);
    expect(() => window(2.6)).toThrow(`overlaps opening #${second.openingId}`);
  } finally { slots.mockRestore(); }
});

it('#10555 keeps bounded candidate queries for a large void class', async () => {
  const s = await sourceOverride();
  const crowd = crowdVoidClass(s);
  const mine = s.view.createEntity('IfcRelVoidsElement', ['mine', null, null, null, '#777', '#901000']).expressId;
  const slots = vi.spyOn(s.view, 'getNewEntityReferenceSlotIds');
  try {
    expect([...hostOpeningCandidates(s.store, 777, s.view)]).toEqual([mine]);
    expect(slots).toHaveBeenCalled();
    expect([...hostOpeningCandidates(s.store, 555, s.view)]).toEqual(crowd);
  } finally { slots.mockRestore(); }
});

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

it.each(['small', 'large'] as const)('#8452 retype, deletion and unreadable-host semantics hold for a %s void class', async (size) => {
  const s = await sourceOverride();
  if (size === 'large') crowdVoidClass(s);
  s.view.setEntityType(s.id, 'IfcRelVoidsElement');
  s.view.setPositionalAttribute(s.id, 4, 'unreadable host');
  expect(readHostOpeningExtents(s.store, 777, s.view).unreadable).toContain(s.id);
  s.view.setPositionalAttribute(s.id, 4, '#777');
  s.view.setPositionalAttribute(s.id, 5, '#888');
  expect([...hostOpeningCandidates(s.store, 777, s.view)]).toContain(s.id);
  s.view.deleteEntity(s.id);
  expect([...hostOpeningCandidates(s.store, 777, s.view)]).not.toContain(s.id);
});
