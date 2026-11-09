/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Charter selector targets → IFCX attribute keys.
 *
 * Authority is judged per IFCX attribute key (12 §12.3), so a charter
 * selector target has to say which keys it names. Each key maps onto a
 * dotted path in the capability-target vocabulary, and a target matches
 * a key when it matches a PREFIX of that path segment by segment:
 *
 *   bsi::ifc::v5a::Pset_WallCommon::FireRating → Pset_WallCommon.FireRating
 *   bsi::ifc::prop::FireRating                 → prop.FireRating
 *   bsi::ifc::class                            → attr.class
 *   bsi::ifc::material                         → material
 *   usd::xformop                               → placement
 *   usd::usdgeom::mesh                         → geometry.mesh
 *
 * so `Pset_WallCommon` (a set) covers all of its members and `geometry`
 * covers every tier. Keys with no path (anything else) are only matched
 * by the universal target `*`.
 *
 * The merge vocabulary writes `attr:class` and `geometry:<tier>`; inside a
 * capability the first `:` already separates action from target, so the
 * charter uses `.` there instead.
 *
 * Spec: docs/architecture/layer-prs/12-authority.md §12.3.
 */

import type { CapabilityTarget, CapabilityTargetSegment } from '../types.js';

const V5A_PREFIX = 'bsi::ifc::v5a::';
const PROP_PREFIX = 'bsi::ifc::prop::';
const BSI_PREFIX = 'bsi::ifc::';
const SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function validSegments(segments: string[]): string[] | undefined {
  return segments.every((segment) => SEGMENT_RE.test(segment)) ? segments : undefined;
}

/** The selector path of an IFCX attribute key, or undefined when it has none. */
export function attributeSelectorPath(attributeKey: string): string[] | undefined {
  if (attributeKey.startsWith(V5A_PREFIX)) {
    const parts = attributeKey.slice(V5A_PREFIX.length).split('::');
    return parts.length === 2 ? validSegments(parts) : undefined;
  }
  if (attributeKey.startsWith(PROP_PREFIX)) {
    return validSegments(['prop', attributeKey.slice(PROP_PREFIX.length)]);
  }
  if (attributeKey === 'bsi::ifc::material') return ['material'];
  if (attributeKey === 'usd::xformop') return ['placement'];
  if (attributeKey.startsWith('usd::')) {
    return validSegments(['geometry', attributeKey.split('::').pop() ?? '']);
  }
  if (attributeKey.startsWith(BSI_PREFIX)) {
    const rest = attributeKey.slice(BSI_PREFIX.length);
    return rest.includes('::') ? undefined : validSegments(['attr', rest]);
  }
  return undefined;
}

function segmentMatches(pattern: CapabilityTargetSegment, segment: string): boolean {
  if (pattern.kind === 'glob') return true;
  if (pattern.value.endsWith('*')) return segment.startsWith(pattern.value.slice(0, -1));
  return pattern.value === segment;
}

/** True iff `target` names `attributeKey`. */
export function targetMatchesAttribute(target: CapabilityTarget, attributeKey: string): boolean {
  if (target.isUniversalWildcard) return true;
  const path = attributeSelectorPath(attributeKey);
  if (!path || target.segments.length > path.length) return false;
  return target.segments.every((pattern, i) => segmentMatches(pattern, path[i]));
}

/** Could two segment patterns both match one concrete segment? */
function segmentsOverlap(a: CapabilityTargetSegment, b: CapabilityTargetSegment): boolean {
  if (a.kind === 'glob' || b.kind === 'glob') return true;
  const aPrefix = a.value.endsWith('*') ? a.value.slice(0, -1) : undefined;
  const bPrefix = b.value.endsWith('*') ? b.value.slice(0, -1) : undefined;
  if (aPrefix !== undefined && bPrefix !== undefined) {
    return aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix);
  }
  if (aPrefix !== undefined) return b.value.startsWith(aPrefix);
  if (bPrefix !== undefined) return a.value.startsWith(bPrefix);
  return a.value === b.value;
}

/**
 * Could two targets of the same length name one attribute key? Only used
 * between equally specific rules, which always have equal length.
 */
export function targetsOverlap(a: CapabilityTarget, b: CapabilityTarget): boolean {
  if (a.isUniversalWildcard || b.isUniversalWildcard) return true;
  if (a.segments.length !== b.segments.length) return false;
  return a.segments.every((segment, i) => segmentsOverlap(segment, b.segments[i]));
}

/** Could two IFC type patterns (trailing `*` glob) cover one type? */
export function typePatternsOverlap(a: string, b: string): boolean {
  return segmentsOverlap({ kind: 'literal', value: a }, { kind: 'literal', value: b });
}
