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

const isSiteContext = (reference: ModelSpatialReference): boolean => reference.sourceMetadata?.format === 'site-context';

/**
 * The owner's height rule for site context (heights in LN02, EPSG:5728)
 * placed against another model: an IFC model that states no vertical datum
 * at all is taken as LN02, with the assumption recorded so the UI warns; one
 * that states any other datum (LHN95, or a name that does not resolve) is
 * refused rather than mixed. The assumption was decided for IFC only: any
 * other format with no vertical datum (LandXML, a scan, a point cloud) is
 * refused, as federation refuses an unknown vertical datum elsewhere
 * (#10481 review). `null` when neither or both sides are site context.
 */
export function siteContextVerticalPolicy(source: ModelSpatialReference, target: ModelSpatialReference): UnknownVerticalPolicy | null {
  if (isSiteContext(source) === isSiteContext(target)) return null;
  const other = isSiteContext(source) ? target : source;
  return verticalDeclaration(other) === undefined && other.sourceMetadata?.format === 'ifc' ? 'assume-compatible' : 'refuse';
}

/**
 * Why site context cannot be placed against `anchor`'s heights, or `null`. A
 * different declared datum is refused before anything loads; an absent one is
 * the assumed case above.
 */
export function siteContextHeightRefusal(anchor: ModelSpatialReference): string | null {
  const declared = anchor.vertical?.id ?? (typeof anchor.sourceMetadata?.verticalDatum === 'string' ? anchor.sourceMetadata.verticalDatum.trim() : '');
  if (!declared || declared === 'EPSG:5728') return null;
  return declared;
}

/** A choice for IFC loads only; never extends a LandXML/scan's own policy. Site context follows its own rule. */
export function ifcUnknownVerticalPolicy(
  source: ModelSpatialReference, target: ModelSpatialReference, enabled: boolean,
): UnknownVerticalPolicy {
  const siteContext = siteContextVerticalPolicy(source, target);
  if (siteContext) return siteContext;
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

/** Only offer an unused choice for the resolver's actual unknown-vertical refusal. */
export function ifcVerticalAssumptionHint(
  source: ModelSpatialReference, target: ModelSpatialReference, enabled: boolean,
): string {
  if (enabled || source.sourceMetadata?.format !== 'ifc' || conflictingVerticalDeclarations(source, target)
    || siteContextVerticalPolicy(source, target)) return '';
  const resolved = resolveSpatialPlacement(source, target);
  if (resolved.ok || resolved.refusal !== 'vertical-crs-unknown') return '';
  const reason = unresolvedVertical(source, target)
    ? 'A vertical datum declaration could not be resolved.' : 'A vertical datum is missing.';
  return ` ${reason} If you know these models share a height system, enable the IFC federation assumption in Settings → General, then reload or re-align.`;
}
