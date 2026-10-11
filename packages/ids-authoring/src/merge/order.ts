/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Order and placement for the merged document. Order is not a field two
 * sides can agree on piecewise, so it is settled per list: the side that
 * reordered the list wins; when both reordered it differently, theirs
 * wins (last writer) and the merge reports MERGE-ORDER-001. Nodes the
 * winning list does not hold (added on the other side) are inserted after
 * their nearest predecessor in the other side's list.
 */

import { SECTIONS } from '../diff/align.js';
import type { DiffEntry, DiffOrder, DocumentDiff } from '../diff/types.js';
import type { Section, StudioDocument } from '../document/types.js';
import type { Uuid } from '../uuid.js';
import type { MergeDiagnostic } from './types.js';

/** Common elements of `side`, in `side` order, differ from `base` order. */
export function reordered(base: readonly Uuid[], side: readonly Uuid[]): boolean {
  const inSide = new Set(side);
  const inBase = new Set(base);
  const b = base.filter((x) => inSide.has(x));
  const s = side.filter((x) => inBase.has(x));
  return b.some((x, i) => s[i] !== x);
}

/** `primary` filtered to `members`, plus members only `secondary` holds, placed after their predecessor there. */
export function mergeList(primary: readonly Uuid[], secondary: readonly Uuid[], members: ReadonlySet<Uuid>): Uuid[] {
  const out = primary.filter((x) => members.has(x));
  const placed = new Set(out);
  secondary.forEach((id, i) => {
    if (!members.has(id) || placed.has(id)) return;
    let at = 0;
    for (let k = i - 1; k >= 0; k--) {
      const pos = out.indexOf(secondary[k]);
      if (pos >= 0) {
        at = pos + 1;
        break;
      }
    }
    out.splice(at, 0, id);
    placed.add(id);
  });
  for (const id of members) if (!placed.has(id)) out.push(id);
  return out;
}

function pickList(
  base: readonly Uuid[],
  ours: readonly Uuid[],
  theirs: readonly Uuid[],
  members: ReadonlySet<Uuid>,
  diagnose: () => void,
): Uuid[] {
  const o = reordered(base, ours);
  const t = reordered(base, theirs);
  if (o && t) {
    const common = (l: readonly Uuid[]) => l.filter((x) => members.has(x) && ours.includes(x) && theirs.includes(x));
    if (common(ours).join() !== common(theirs).join()) diagnose();
    return mergeList(theirs, ours, members);
  }
  return o ? mergeList(ours, theirs, members) : mergeList(theirs, ours, members);
}

type Place = { specId: Uuid; section: Section };

function basePlaces(doc: StudioDocument): Map<Uuid, Place> {
  const places = new Map<Uuid, Place>();
  doc.nodes.specs.forEach((spec) => {
    for (const section of SECTIONS) {
      for (const f of section === 'applicability' ? spec.applicability : spec.requirements) places.set(f.id, { specId: spec.id, section });
    }
  });
  return places;
}

function baseOrder(doc: StudioDocument): DiffOrder {
  const order: DiffOrder = { specs: [], sections: {} };
  doc.nodes.specs.forEach((spec) => {
    order.specs.push(spec.id);
    order.sections[spec.id] = { applicability: spec.applicability.map((f) => f.id), requirements: spec.requirements.map((f) => f.id) };
  });
  return order;
}

/** The target order of the merged document, given the entries the merge applies. */
export function mergeOrder(base: StudioDocument, ours: DocumentDiff, theirs: DocumentDiff, chosen: readonly DiffEntry[], diagnostics: MergeDiagnostic[]): DiffOrder {
  const specs = new Set(base.nodes.specs.map((s) => s.id));
  const places = basePlaces(base);
  for (const e of chosen) {
    if (e.kind === 'spec.added') {
      specs.add(e.specId);
      e.nodes.applicability.forEach((f) => places.set(f.id, { specId: e.specId, section: 'applicability' }));
      e.nodes.requirements.forEach((f) => places.set(f.id, { specId: e.specId, section: 'requirements' }));
    }
  }
  for (const e of chosen) {
    if (e.kind === 'facet.added') places.set(e.facetId, { specId: e.specId, section: e.section });
    if (e.kind === 'facet.moved') places.set(e.facetId, { specId: e.to.specId, section: e.to.section });
    if (e.kind === 'facet.removed') places.delete(e.facetId);
  }
  for (const e of chosen) {
    if (e.kind !== 'spec.removed') continue;
    specs.delete(e.specId);
    for (const [id, p] of places) if (p.specId === e.specId) places.delete(id);
  }
  const b = baseOrder(base);
  const order: DiffOrder = { specs: [], sections: {} };
  order.specs = pickList(b.specs, ours.order.specs, theirs.order.specs, specs, () =>
    diagnostics.push({ code: 'MERGE-ORDER-001', message: 'Both sides reordered the specifications; their order was kept.' }),
  );
  for (const specId of order.specs) {
    const lists = { applicability: [] as Uuid[], requirements: [] as Uuid[] };
    for (const section of SECTIONS) {
      const members = new Set([...places].filter(([, p]) => p.specId === specId && p.section === section).map(([id]) => id));
      lists[section] = pickList(
        b.sections[specId]?.[section] ?? [],
        ours.order.sections[specId]?.[section] ?? [],
        theirs.order.sections[specId]?.[section] ?? [],
        members,
        () =>
          diagnostics.push({
            code: 'MERGE-ORDER-001',
            message: `Both sides reordered the ${section} of a specification; their order was kept.`,
            specId,
          }),
      );
    }
    order.sections[specId] = lists;
  }
  return order;
}
