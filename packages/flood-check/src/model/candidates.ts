/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which elements are candidates, and their level: one walk over the covered
 * elements, one verdict each.
 *
 * 1. {@link coveredElements} lists every element of a covered class: doors,
 *    windows, openings, light wells (proxies, chambers, civil elements,
 *    assemblies and openings whose Name/ObjectType say so, DE/FR/IT/EN),
 *    stairs, ramps and their flights, and technical equipment (by class and
 *    predefined kind, or a generic occurrence typed by an equipment type; see
 *    `equipment.ts`).
 * 2. Each gets exactly one verdict from its rule in `candidate-rules.ts`,
 *    from its own data: a candidate, or a skip with the reason.
 * 3. Then, from those verdicts only: an element of a building that is not
 *    checked is skipped as such; an opening whose door or window IS a
 *    candidate is reported through it; a flight whose stair or ramp is a
 *    candidate is reported through it. These steps only ever turn a verdict
 *    into a skip that names a candidate, never the other way round.
 * 4. The candidate and skipped lists are built in one place from the one
 *    verdict per element, so every covered element is in exactly one of them.
 *
 * The rules (`candidate-rules.ts`): doors and windows in the façade by
 * `IsExternal` on the element or its host wall (an external host wins over
 * the element's own `false`), else within `boundaryTolerance` of the outline,
 * at the hole they fill and the lower of their placement and the hole's
 * bottom; unfilled (or not otherwise reported) openings in external walls and
 * in slabs at or below the ground storey; stairs and ramps outside the
 * footprint (by placement, by any body corner, or with no fully readable body
 * by a placement within `boundaryTolerance`) or `IsExternal`, skipped only
 * when a complete body proves they lead up; equipment in the ground storey or
 * below. Doors, windows and openings above `ground storey + aboveGroundScope`
 * (by their corrected level) are out of scope. A rule that would rest on
 * unreadable data keeps the element, with an upper-estimate level where its
 * level is in doubt, so it can flag but never reassure.
 */

import { RelationshipType } from '@ifc-lite/data';
import type { CandidateFact } from './facts.js';
import { EQUIPMENT_OCCURRENCES, EQUIPMENT_TYPES, GENERIC_OCCURRENCES } from './equipment.js';
import type { DecodedEntity } from './reader.js';
import { predefinedType, type CandidateContext } from './candidate-base.js';
import {
  descentVerdict,
  elementLabel,
  equipmentVerdict,
  fillingVerdict,
  LIGHT_WELL_NAME,
  lightWellVerdict,
  openingVerdict,
  type Verdict,
} from './candidate-rules.js';

export { isExternal, type CandidateContext } from './candidate-base.js';
export { LIGHT_WELL_NAME } from './candidate-rules.js';

const FILLING_TYPES = ['IFCDOOR', 'IFCDOORSTANDARDCASE', 'IFCWINDOW', 'IFCWINDOWSTANDARDCASE'];
const DESCENT_TYPES: ReadonlyArray<readonly [string, 'stair' | 'ramp']> = [
  ['IFCSTAIR', 'stair'],
  ['IFCSTAIRFLIGHT', 'stair'],
  ['IFCRAMP', 'ramp'],
  ['IFCRAMPFLIGHT', 'ramp'],
];
const LIGHT_WELL_TYPES = ['IFCBUILDINGELEMENTPROXY', 'IFCDISTRIBUTIONCHAMBERELEMENT', 'IFCCIVILELEMENT', 'IFCELEMENTASSEMBLY', 'IFCOPENINGELEMENT'];

/** A covered element and the rule that decides it. */
interface Covered {
  entity: DecodedEntity;
  /** `opening`: may be reported through its door or window; `flight`: through its stair or ramp. */
  role?: 'opening' | 'flight';
  decide(ctx: CandidateContext): Verdict;
}

/**
 * Every element of a covered class, each once, with its rule, in the order
 * candidates are listed (doors, windows, openings, light wells, stairs,
 * ramps, equipment).
 */
export function coveredElements(ctx: CandidateContext): Covered[] {
  const r = ctx.reader;
  const out: Covered[] = [];
  const of = (type: string) => r.idsOfType(type).map((id) => r.entity(id)).filter((e): e is DecodedEntity => e !== null);
  const named = (e: DecodedEntity) => LIGHT_WELL_NAME.test(elementLabel(ctx, e));
  for (const type of FILLING_TYPES) for (const e of of(type)) out.push({ entity: e, decide: (c) => fillingVerdict(c, e) });
  for (const e of of('IFCOPENINGELEMENT')) {
    if (named(e)) continue; // a light well, below
    const filled = r.related(e.expressId, RelationshipType.FillsElement, 'forward').length > 0;
    out.push({ entity: e, role: 'opening', decide: (c) => openingVerdict(c, e, filled) });
  }
  for (const type of LIGHT_WELL_TYPES) for (const e of of(type)) if (named(e)) out.push({ entity: e, decide: (c) => lightWellVerdict(c, e) });
  for (const [type, category] of DESCENT_TYPES) {
    for (const e of of(type)) out.push({ entity: e, role: type.endsWith('FLIGHT') ? 'flight' : undefined, decide: (c) => descentVerdict(c, e, category) });
  }
  for (const { type, predefined } of EQUIPMENT_OCCURRENCES) for (const e of of(type)) out.push({ entity: e, decide: (c) => equipmentVerdict(c, e, { predefined }) });
  for (const type of GENERIC_OCCURRENCES) {
    for (const e of of(type)) {
      const typeObject = r.related(e.expressId, RelationshipType.DefinesByType, 'inverse').map((t) => r.entity(t)).find((t) => t !== null && EQUIPMENT_TYPES.has(t.type));
      if (!typeObject) continue; // an untyped generic occurrence is not covered
      const kind = predefinedType(r, e);
      out.push({ entity: e, decide: (c) => equipmentVerdict(c, e, `${r.className(e)} typed ${r.className(typeObject)}${kind ? ` ${kind}` : ''}`) });
    }
  }
  return out;
}

export interface CandidateSelection {
  candidates: CandidateFact[];
  /** Covered elements that are not candidates, each with its reason. */
  skipped: Array<{ expressId: number; ifcClass: string; reason: string }>;
  /** Covered elements walked: always `candidates.length + skipped.length`. */
  walked: number;
}

/**
 * Select candidates. `notChecked(id)` names the building of an element that
 * is not checked (null when it is checked or in no building).
 */
export function selectCandidates(ctx: CandidateContext, notChecked: (id: number) => string | null = () => null): CandidateSelection {
  const r = ctx.reader;
  const walk = coveredElements(ctx);
  // One verdict per covered element; the later steps replace a verdict, never add one.
  const verdicts = new Map<number, Verdict>();
  for (const { entity, decide } of walk) {
    if (verdicts.has(entity.expressId)) throw new Error(`candidate selection walked #${entity.expressId} twice`);
    verdicts.set(entity.expressId, decide(ctx));
  }
  for (const [id, v] of verdicts) {
    const building = v.candidate ? notChecked(id) : null;
    if (building) verdicts.set(id, { skip: `in building ${building}, which was not checked` });
  }
  const isCandidate = (id: number | undefined) => id !== undefined && verdicts.get(id)?.candidate !== undefined;
  for (const { entity, role } of walk) {
    const id = entity.expressId;
    const own = verdicts.get(id)!;
    if (role === 'opening') {
      const filling = r.related(id, RelationshipType.FillsElement, 'forward').map((f) => r.entity(f)).find((f) => f !== null && FILLING_TYPES.includes(f.type));
      if (!filling) continue;
      if (isCandidate(filling.expressId)) {
        verdicts.set(id, { skip: `filled by ${r.className(filling)} #${filling.expressId}, which is reported for it` });
      } else if (own.candidate) {
        own.candidate.notes = [`its filling ${r.className(filling)} #${filling.expressId} is not a candidate (see skipped), so the hole is checked itself`, ...(own.candidate.notes ?? [])];
      }
    } else if (role === 'flight') {
      // Reported through its stair or ramp only when that is a candidate; otherwise the flight's own verdict stands
      // (a stair skipped as interior or unplaceable says nothing about a flight that reaches outside).
      const container = r.related(id, RelationshipType.Aggregates, 'inverse')[0];
      if (container !== undefined && isCandidate(container)) verdicts.set(id, { skip: `part of #${container}, which is reported for it` });
    }
  }
  // The single place the two lists are built: each covered element lands in exactly one.
  const candidates: CandidateFact[] = [];
  const skipped: CandidateSelection['skipped'] = [];
  for (const { entity } of walk) {
    const v = verdicts.get(entity.expressId)!;
    if (v.candidate) candidates.push(v.candidate);
    else skipped.push({ expressId: entity.expressId, ifcClass: r.className(entity), reason: v.skip });
  }
  return { candidates, skipped, walked: walk.length };
}
