/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Why rail cant and road superelevation are refused, and on which alignments
 * (mapping spec §13).
 *
 * Both are refused on purpose, for reasons that are about IFC 4.3 ADD2 and the
 * source format rather than about missing code, so the refusal says which:
 *
 * - cant has an IFC home (`IfcAlignmentCant`), but IFC permits it only beside
 *   a vertical layout and requires an `IfcSegmentedReferenceCurve` for it that
 *   no engine this repo does not control can yet regenerate (§13.2);
 * - superelevation has an IFC home too (`IfcReferent` `.SUPERELEVATIONEVENT.`
 *   with `Pset_Superelevation`), but it needs values LandXML does not carry
 *   (§13.4).
 *
 * The records stay opaque (`source-types.ts`): only the alignment's name and
 * how many records it carries are read, so a refusal cannot quietly become a
 * partial export.
 */

import type { LandXmlIfcAlignment } from './source-types.js';

/** §13.2, in the operator's terms. */
export const CANT_REFUSAL_REASON =
  'IFC 4.3 carries rail cant as an IfcAlignmentCant, which it permits only together with a vertical layout '
  + '(cant heights are measured from it), and whose geometry must be an IfcSegmentedReferenceCurve on that '
  + "layout's IfcGradientCurve; that geometry cannot yet be checked by an independent engine, and LandXML "
  + "gives the track gauge, not the rail-head distance IFC needs, so the alignment is written with its "
  + 'horizontal (and, where profiled, vertical) layout only (mapping spec §13)';

/** §13.4, in the operator's terms. */
export const SUPERELEVATION_REFUSAL_REASON =
  'IFC 4.3 carries road superelevation as IfcReferent .SUPERELEVATIONEVENT. with Pset_Superelevation, which '
  + 'needs a cross slope and a side at every event; LandXML gives the event stations and one FullSuperelev rate, '
  + 'but not the normal-crown slope at the runout events, nor the side, nor an unambiguous scale for the rate, '
  + 'so writing it would invent values (mapping spec §13)';

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Every alignment that carries cant, named with its station count. */
export function cantRefusalMessage(alignments: readonly LandXmlIfcAlignment[]): string {
  const carrying = alignments.filter((alignment) => alignment.cant || (alignment.cantStations?.length ?? 0) > 0);
  const named = carrying.map((alignment) =>
    `'${alignment.name || alignment.sourceId}': ${plural(alignment.cantStations?.length ?? 0, 'CantStation')}`);
  return `${plural(carrying.length, 'cant record')} will not be included (${named.join('; ')}): `
    + `${CANT_REFUSAL_REASON}.`;
}

/** Every alignment that carries superelevation, named with its block count. */
export function superelevationRefusalMessage(alignments: readonly LandXmlIfcAlignment[]): string {
  const carrying = alignments.filter((alignment) => (alignment.superelevations?.length ?? 0) > 0);
  const total = carrying.reduce((n, alignment) => n + (alignment.superelevations?.length ?? 0), 0);
  const named = carrying.map((alignment) =>
    `'${alignment.name || alignment.sourceId}': ${plural(alignment.superelevations?.length ?? 0, 'Superelevation block')}`);
  return `${plural(total, 'superelevation record')} will not be included (${named.join('; ')}): `
    + `${SUPERELEVATION_REFUSAL_REASON}.`;
}
