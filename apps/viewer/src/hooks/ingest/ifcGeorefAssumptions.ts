/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolveSpatialPlacement, type ModelSpatialReference } from '@ifc-lite/geometry';
import type { UnknownVerticalPolicy } from './federationSpatialTransform.js';

/** Canonical IDs take precedence over raw names, including existing authoritative aliases. */
function verticalDeclaration(reference: ModelSpatialReference): string | undefined {
  if (reference.vertical) return `canonical:${reference.vertical.id}`;
  const raw = reference.sourceMetadata?.verticalDatum;
  return typeof raw === 'string' && raw.trim() ? `unresolved:${raw.trim()}` : undefined;
}

/** Different unreconciled declarations are not permission to assume an absent datum (#8042). */
export function conflictingVerticalDeclarations(source: ModelSpatialReference, target: ModelSpatialReference): boolean {
  const a = verticalDeclaration(source);
  const b = verticalDeclaration(target);
  return a !== undefined && b !== undefined && a !== b;
}

/** A choice for IFC loads only; never extends a LandXML/scan's own policy. */
export function ifcUnknownVerticalPolicy(
  source: ModelSpatialReference, target: ModelSpatialReference, enabled: boolean,
): UnknownVerticalPolicy {
  return enabled && source.sourceMetadata?.format === 'ifc'
    && !conflictingVerticalDeclarations(source, target) ? 'assume-compatible' : 'refuse';
}

/** True retains the original missing-datum marker; unresolved authored names get explicit provenance. */
export type IfcVerticalAssumptionApplied = true | 'unresolved';

function unresolvedVertical(source: ModelSpatialReference, target: ModelSpatialReference): boolean {
  return [source, target].some((reference) => !reference.vertical && verticalDeclaration(reference) !== undefined);
}

/** Record reliance, not just permission. A known mismatch still fails upstream. */
export function ifcSharedVerticalDatumApplied(
  source: ModelSpatialReference, target: ModelSpatialReference,
  status: string | undefined, enabled: boolean,
): IfcVerticalAssumptionApplied | undefined {
  const aligned = status === 'identity' || status === 'same-crs' || status === 'reprojected';
  if (!aligned || ifcUnknownVerticalPolicy(source, target, enabled) !== 'assume-compatible'
    || (source.vertical && target.vertical)) return undefined;
  return unresolvedVertical(source, target) ? 'unresolved' : true;
}

/** Only offer an unused choice for an actual unknown-vertical refusal, which cross-CRS placement applies after the resolver's CRS check. */
export function ifcVerticalAssumptionHint(
  source: ModelSpatialReference, target: ModelSpatialReference, enabled: boolean,
): string {
  if (enabled || source.sourceMetadata?.format !== 'ifc' || conflictingVerticalDeclarations(source, target)) return '';
  const resolved = resolveSpatialPlacement(source, target);
  if (resolved.ok) return '';
  const unknownVertical = resolved.refusal === 'vertical-crs-unknown'
    || (resolved.refusal === 'crs-mismatch' && !(source.vertical && target.vertical));
  if (!unknownVertical) return '';
  const reason = unresolvedVertical(source, target)
    ? 'A vertical datum declaration could not be resolved.' : 'A vertical datum is missing.';
  return ` ${reason} If you know these models share a height system, enable the IFC federation assumption in Settings → General, then reload or re-align.`;
}
