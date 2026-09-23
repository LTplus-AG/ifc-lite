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

import type { LandXmlIfcSource, LandXmlIfcSurface } from './source-types.js';
import type { LandXmlRefusal, LandXmlRefusedFamily } from './result-types.js';

/**
 * Why each family is out of scope, in the operator's terms.
 *
 * Kept as one table rather than inline strings so the export dialog, the
 * provenance property set and the refusal report cannot drift apart on what
 * the same family is called.
 */
const FAMILY_REASONS: Record<LandXmlRefusedFamily, string> = {
  alignments: 'horizontal alignment geometry (stationing, curves, spirals, cant) has no v1 mapping; IfcAlignment is a separate piece of work with its own review',
  profiles: 'vertical profiles and their grade lines and vertical curves have no v1 mapping — they describe geometry along an alignment, which v1 does not carry',
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
export function collectRefusals(source: LandXmlIfcSource): LandXmlRefusal[] {
  const counts: Array<[LandXmlRefusedFamily, number]> = [
    ['alignments', source.alignments?.length ?? 0],
    ['profiles', source.profiles?.length ?? 0],
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
      message: `${count} ${family.replace(/-/g, ' ')} record${count === 1 ? '' : 's'} will not be included: ${FAMILY_REASONS[family]}.`,
    }));
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
    return 'This LandXML file carries no triangulated surface and no CgPoints, so there is nothing the IFC mapping can write.';
  }
  const families = refusals.map((refusal) => `${refusal.count} ${refusal.family.replace(/-/g, ' ')}`).join(', ');
  return `This LandXML file carries no record the IFC mapping covers. It contains ${families}, `
    + 'none of which has a v1 mapping. Export the original LandXML file instead.';
}
