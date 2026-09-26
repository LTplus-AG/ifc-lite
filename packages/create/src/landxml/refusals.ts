/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Enumerate the LandXML record families a source carries that v1 does not map.
 *
 * §5 of the mapping spec: named, never silently dropped. The point of counting
 * them is that "this file has 14 alignments and none of them are in your IFC"
 * is actionable, while a missing record is not even noticeable.
 */

import type { LandXmlIfcAlignment, LandXmlIfcSource, LandXmlIfcSurface } from './source-types.js';
import type { LandXmlRefusal, LandXmlRefusedFamily } from './result-types.js';
import {
  cogoPointResolver, isAlignmentRecord, mapAlignments, type AlignmentMapping, type RefusedAlignment,
} from './alignment-mapping.js';
import { mapProfiles, type ProfileMapping, type RefusedProfile } from './profile-mapping.js';
import { stationEquationsOf, type StationEquationMapping } from './station-equations.js';
import {
  CANT_REFUSAL_REASON, SUPERELEVATION_REFUSAL_REASON, cantRefusalMessage, superelevationRefusalMessage,
} from './cant-superelevation.js';

/**
 * Why each family is out of scope, in the operator's terms.
 *
 * Kept as one table rather than inline strings so the export dialog, the
 * provenance property set and the refusal report cannot drift apart on what
 * the same family is called.
 */
const FAMILY_REASONS: Record<LandXmlRefusedFamily, string> = {
  alignments: 'an alignment is written only when every horizontal segment is a line, circular arc or clothoid that reproduces its authored end point; one that does not is refused whole, because a gap would make every later station wrong',
  profiles: 'a profile is written, as IfcAlignmentVertical, only when it is the one design profile of a written alignment and its grades and vertical curves reproduce every authored PVI; one that does not is refused whole',
  'cross-sections': 'cross sections have no v1 mapping — they are sampled along an alignment, which v1 does not carry',
  roadways: 'roadways have no v1 mapping — they compose alignments and surfaces, and v1 carries only the surfaces',
  parcels: 'parcel boundaries have no v1 mapping',
  monuments: 'survey monuments have no v1 mapping; only CgPoints become IfcAnnotation/.SURVEY.',
  'plan-features': 'plan features have no v1 mapping',
  'pipe-networks': 'pipe networks, structures and pipes have no v1 mapping',
  'surface-boundaries': 'surface boundary polylines are not written; only the triangulated surface itself is',
  'surface-breaklines': 'surface breaklines are not written; only the triangulated surface itself is',
  'surface-contours': 'surface contour lines are not written; only the triangulated surface itself is',
  'non-rendered-surfaces': 'surfaces that carry no numeric, renderable triangulation (or whose every face is hidden) cannot become an IfcTriangulatedIrregularNetwork',
  'unlocated-cgpoints': 'CgPoints that carry only a point reference and no coordinates of their own have nothing to place',
  'station-equations': "an alignment's station equations are written all or none, because a dropped one would make every later station wrong; the alignment is still written, with its start station only",
  cant: CANT_REFUSAL_REASON,
  superelevation: SUPERELEVATION_REFUSAL_REASON,
};

function countAcrossSurfaces(
  surfaces: readonly LandXmlIfcSurface[],
  pick: (surface: LandXmlIfcSurface) => readonly unknown[] | undefined,
): number {
  return surfaces.reduce((total, surface) => total + (pick(surface)?.length ?? 0), 0);
}

/**
 * A surface v1 can write: a rendered TIN with vertices and at least one
 * VISIBLE face. A surface whose every face is an authored `<F i="true">` draws
 * nothing, so it is refused by name like any other non-rendered surface rather
 * than vanishing from an otherwise successful export.
 */
export function isMappableSurface(surface: LandXmlIfcSurface): boolean {
  return surface.renderState === 'rendered'
    && surface.points.length > 0
    && surface.faces.some((_, ordinal) => surface.faceVisibility?.[ordinal] !== false);
}

/**
 * Every out-of-scope family the source actually contains, with its count.
 *
 * A family with zero records is absent from the list rather than present with
 * `count: 0` — a refusal the user cannot act on is noise, and "0 parcels were
 * not exported" is exactly that.
 */
/** The alignment mapping for a source, computed the one way both the plan and the export use. */
export function alignmentMappingOf(source: LandXmlIfcSource): AlignmentMapping {
  return mapAlignments(source.alignments, source.units, false, cogoPointResolver(source.plan?.cogoPoints));
}

export function collectRefusals(
  source: LandXmlIfcSource, alignmentMapping: AlignmentMapping = alignmentMappingOf(source),
  profileMapping: ProfileMapping = mapProfiles(
    source.profiles, source.alignments, alignmentMapping, source.units, stationEquationsOf(source, alignmentMapping),
  ),
  stationing: ReadonlyMap<string, StationEquationMapping> = stationEquationsOf(source, alignmentMapping),
): LandXmlRefusal[] {
  // Only the alignments that are WRITTEN carry these on into the IFC; a
  // refused alignment takes its station equations and cant with it, and
  // counting them twice would misstate what is missing.
  const written = new Set(alignmentMapping.mapped.map((alignment) => alignment.sourceId));
  const writtenAlignments = (source.alignments ?? [])
    .filter(isAlignmentRecord)
    .filter((alignment) => written.has(alignment.sourceId));
  const counts: Array<[LandXmlRefusedFamily, number]> = [
    ['alignments', alignmentMapping.refused.length],
    // Written as IfcReferents (§14) unless refused, all or none, per alignment.
    ['station-equations', writtenAlignments.reduce(
      (n, a) => n + (stationing.get(a.sourceId)?.refusal ? (a.stationEquations?.length ?? 0) : 0), 0,
    )],
    ['cant', writtenAlignments.filter((a) => a.cant || (a.cantStations?.length ?? 0) > 0).length],
    ['superelevation', writtenAlignments.reduce((n, a) => n + (a.superelevations?.length ?? 0), 0)],
    ['profiles', profileMapping.refused.length],
    ['cross-sections', (source.crossSections?.length ?? 0) + (source.crossSectionSurfaces?.length ?? 0)],
    ['roadways', source.roadways?.length ?? 0],
    ['parcels', source.plan?.parcels?.length ?? 0],
    ['monuments', source.plan?.monuments?.length ?? 0],
    ['plan-features', source.plan?.planFeatures?.length ?? 0],
    ['pipe-networks', source.pipeNetworks?.networks?.length ?? 0],
    ['surface-boundaries', countAcrossSurfaces(source.surfaces, (s) => s.boundaries)],
    ['surface-breaklines', countAcrossSurfaces(source.surfaces, (s) => s.breaklines)],
    ['surface-contours', countAcrossSurfaces(source.surfaces, (s) => s.contours)],
    ['non-rendered-surfaces', source.surfaces.filter((s) => !isMappableSurface(s)).length],
    ['unlocated-cgpoints', (source.plan?.cogoPoints ?? []).filter((point) => point.point === null).length],
  ];

  return counts
    .filter(([, count]) => count > 0)
    .map(([family, count]) => ({
      family,
      count,
      message: family === 'alignments'
        ? alignmentRefusalMessage(alignmentMapping.refused)
        : family === 'profiles'
          ? profileRefusalMessage(profileMapping.refused)
          : family === 'station-equations'
            ? stationEquationRefusalMessage(count, writtenAlignments, stationing)
            : family === 'cant'
              ? cantRefusalMessage(writtenAlignments)
              : family === 'superelevation'
                ? superelevationRefusalMessage(writtenAlignments)
                : `${count} ${family.replace(/-/g, ' ')} record${count === 1 ? '' : 's'} will not be included: ${FAMILY_REASONS[family]}.`,
    }));
}

/**
 * Name each refused alignment and why. A count alone ("2 alignments") leaves
 * the operator unable to tell a spiral type from a gap from a sign problem.
 */
export function alignmentRefusalMessage(refused: readonly RefusedAlignment[]): string {
  // Every one is named: an alignment left out as "and N more" is one the
  // operator cannot find or fix (#5370 review).
  const count = refused.length;
  const named = refused.map((entry) => `'${entry.name}': ${entry.reason}`);
  return `${count} alignment record${count === 1 ? '' : 's'} will not be included (${named.join('; ')}). `
    + `${FAMILY_REASONS.alignments}.`;
}

/** Name each refused profile and why (§12.6), as alignments are. */
export function profileRefusalMessage(refused: readonly RefusedProfile[]): string {
  const count = refused.length;
  const named = refused.map((entry) => `'${entry.name}': ${entry.reason}`);
  return `${count} profile record${count === 1 ? '' : 's'} will not be included (${named.join('; ')}). `
    + `${FAMILY_REASONS.profiles}.`;
}

/** Name each alignment whose station equations were refused, and why (§14.2). */
function stationEquationRefusalMessage(
  count: number, alignments: readonly LandXmlIfcAlignment[], stationing: ReadonlyMap<string, StationEquationMapping>,
): string {
  const named = alignments.flatMap((alignment) => {
    const reason = stationing.get(alignment.sourceId)?.refusal;
    return reason ? [`'${alignment.name || alignment.sourceId}': ${reason}`] : [];
  });
  return `${count} station equation record${count === 1 ? '' : 's'} will not be included (${named.join('; ')}). `
    + `${FAMILY_REASONS['station-equations']}.`;
}

/**
 * The sentence shown when nothing in the source is mappable.
 *
 * It names what the file *does* hold. A bare "nothing to export" leaves the
 * operator to guess whether the file is empty, unsupported, or broken — and
 * for the alignment-only files §9.4 is about, the answer is none of those.
 */
export function refusalReason(refusals: readonly LandXmlRefusal[]): string {
  if (refusals.length === 0) {
    return 'This LandXML file carries no triangulated surface, no CgPoints and no alignment, so there is nothing the IFC mapping can write.';
  }
  const families = refusals.map((refusal) => `${refusal.count} ${refusal.family.replace(/-/g, ' ')}`).join(', ');
  return `This LandXML file carries no record the IFC mapping covers. It contains ${families}, `
    + 'none of which has a v1 mapping. Export the original LandXML file instead.';
}
