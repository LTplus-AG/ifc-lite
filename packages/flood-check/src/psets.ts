/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Results as property-set payloads, ready for a later lane to write.
 *
 * No buildingSMART property set covers flood or surface runoff, and the
 * `Pset_` prefix is reserved for buildingSMART, so the sets use the repo's own
 * `IfcLite_` prefix (as `IfcLite_RoofFootprint`, `IfcLite_StoreyAttachment`):
 *
 * - {@link SITE_PSET} on the IfcSite (or IfcBuilding): dataset, dates, class
 *   definition, return period, licence, attribution, limits, parameters.
 * - {@link ELEMENT_PSET} on each checked element: outcome and its numbers.
 *
 * The shape matches `PropertySetDef` of `@ifc-lite/create` structurally
 * (`Name`, `Properties[{ Name, NominalValue, Type }]`). Lengths are converted
 * to the model's project length unit, because a writer emits an
 * `IfcLengthMeasure` value as given. Absent values are omitted, never written
 * as zero.
 */

import type { CandidateResult, FloodCheckResult } from './check/check.js';
import type { HazardClassDefinition } from './types.js';

export const SITE_PSET = 'IfcLite_SurfaceRunoffHazardSite';
export const ELEMENT_PSET = 'IfcLite_SurfaceRunoffExposure';

export type FloodPropertyType = 'IfcLabel' | 'IfcText' | 'IfcIdentifier' | 'IfcInteger' | 'IfcBoolean' | 'IfcLengthMeasure';

export interface FloodProperty {
  Name: string;
  NominalValue: string | number | boolean;
  Type: FloodPropertyType;
}

export interface FloodPropertySet {
  Name: string;
  Properties: FloodProperty[];
}

export interface ElementPropertySet {
  expressId: number;
  globalId: string | null;
  propertySet: FloodPropertySet;
}

class Builder {
  readonly props: FloodProperty[] = [];
  constructor(private readonly unitScale: number) {}
  text(name: string, value: string | null | undefined, type: FloodPropertyType = 'IfcText'): this {
    if (value !== null && value !== undefined && value !== '') this.props.push({ Name: name, NominalValue: value, Type: type });
    return this;
  }
  label(name: string, value: string | null | undefined): this {
    return this.text(name, value, 'IfcLabel');
  }
  int(name: string, value: number): this {
    this.props.push({ Name: name, NominalValue: Math.round(value), Type: 'IfcInteger' });
    return this;
  }
  bool(name: string, value: boolean): this {
    this.props.push({ Name: name, NominalValue: value, Type: 'IfcBoolean' });
    return this;
  }
  /** A length given in metres, written in the project length unit. */
  length(name: string, metres: number | null | undefined): this {
    if (metres !== null && metres !== undefined && Number.isFinite(metres)) {
      this.props.push({ Name: name, NominalValue: metres / this.unitScale, Type: 'IfcLengthMeasure' });
    }
    return this;
  }
}

function classDefinition(classes: readonly HazardClassDefinition[]): string {
  return classes
    .map((c) => {
      if (c.kind === 'depth') {
        return `${c.id}: ${c.lowerBound} m < h${c.upperBound === null ? '' : ` <= ${c.upperBound} m`} (${c.label.en})`;
      }
      return `${c.id}: ${c.label.en} (${c.kind})`;
    })
    .join('; ');
}

/** The site-level set: what the result rests on and what must be shown with it. */
export function sitePropertySet(result: FloodCheckResult, classes: readonly HazardClassDefinition[]): FloodPropertySet {
  const p = result.provenance;
  const b = new Builder(result.lengthUnitScale)
    .text('ProviderId', p.providerId, 'IfcIdentifier')
    .text('Dataset', p.datasetId, 'IfcIdentifier')
    .label('DatasetTitle', `${p.datasetTitle.de} / ${p.datasetTitle.en}`)
    .label('DatasetDate', p.datasetDate)
    .label('MetadataUpdated', p.metadataUpdated)
    .label('RetrievedAt', p.retrievedAt)
    .text('RequestUrl', p.requestUrl)
    .text('ClassDefinition', classDefinition(classes))
    .text('ReturnPeriodDE', p.returnPeriod.de)
    .text('ReturnPeriodEN', p.returnPeriod.en)
    .text('Licence', p.licence)
    .text('Attribution', p.attribution)
    .text('LimitsDE', p.limits.map((l) => l.de).join(' | '))
    .text('LimitsEN', p.limits.map((l) => l.en).join(' | '))
    .text('DisclaimerDE', p.disclaimer.de)
    .text('DisclaimerEN', p.disclaimer.en)
    .text('CoordinateReferenceSystem', result.crs, 'IfcIdentifier')
    .label('TerrainVerticalReference', result.terrainVerticalReference)
    .label('VerticalDatumBasis', result.verticalDatum.basis)
    .label('FootprintSource', result.footprintSource)
    .label('GroundStoreyBasis', result.groundStorey.basis)
    .length('GroundStoreyLevel', result.groundStorey.level)
    .length('ClearanceMargin', result.parameters.clearanceMargin)
    .length('RasterCellSize', result.parameters.rasterCellSize)
    .label('RingDistances', result.parameters.ringDistances.map((d) => `${d} m`).join(', '))
    .length('MinOutsideDistance', result.parameters.minOutsideDistance)
    .label('EdgePolicy', result.parameters.edgePolicy);
  for (const [outcome, count] of Object.entries(result.summary)) {
    b.int(`Count_${outcome.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase())}`, count);
  }
  b.int('CountReachableBelowGroundSpaces', result.reachableBelowGround.length);
  return { Name: SITE_PSET, Properties: b.props };
}

/** The per-element set: outcome and every number behind it. */
export function elementPropertySet(r: CandidateResult, result: FloodCheckResult): FloodPropertySet {
  const c = r.comparison;
  const cls = r.hazardClass;
  const b = new Builder(result.lengthUnitScale)
    .label('Outcome', r.outcome)
    .label('UnclassifiedReason', r.unclassifiedReason)
    .label('Category', r.candidate.category)
    .label('SelectedBecause', r.candidate.selectedBecause)
    .label('HazardClass', cls?.id)
    .length('ClassLowerBound', cls?.lowerBound)
    .length('ClassUpperBound', cls?.upperBound);
  if (cls) b.bool('ClassOpenEnded', cls.upperBound === null);
  b.length('ElementLevel', r.candidate.level)
    .label('LevelBasis', r.candidate.levelBasis)
    .bool('LevelIsUpperEstimate', r.candidate.levelIsUpperEstimate)
    .length('TerrainHeight', r.terrainHeight)
    .length('WaterSurfaceLowerBound', c?.surfaceLowerBound)
    .length('WaterSurfaceUpperBound', c?.surfaceUpperBound)
    .length('LevelAboveSurfaceLowerBound', c?.levelAboveSurfaceLowerBound)
    .length('LevelAboveSurfaceUpperBound', c?.levelAboveSurfaceUpperBound)
    .length('ClearanceMargin', r.clearanceMargin)
    .label('GoverningSample', r.governingSample ? `E ${r.governingSample.x.toFixed(2)}, N ${r.governingSample.y.toFixed(2)} (${result.crs})` : null)
    .int('SamplesOutsideFootprint', r.samples.planned - r.samples.insideFootprint)
    .int('SamplesUnreadable', r.samples.byReading.unclassified + r.samples.byReading.outside)
    .text('Notes', r.notes.join(' | '))
    .text('Dataset', result.provenance.datasetId, 'IfcIdentifier')
    .label('RetrievedAt', result.provenance.retrievedAt);
  return { Name: ELEMENT_PSET, Properties: b.props };
}

/** Both kinds of payload for a whole result. */
export function toPropertySets(
  result: FloodCheckResult,
  classes: readonly HazardClassDefinition[],
): { site: FloodPropertySet; elements: ElementPropertySet[] } {
  return {
    site: sitePropertySet(result, classes),
    elements: result.results.map((r) => ({
      expressId: r.candidate.expressId,
      globalId: r.candidate.globalId,
      propertySet: elementPropertySet(r, result),
    })),
  };
}
