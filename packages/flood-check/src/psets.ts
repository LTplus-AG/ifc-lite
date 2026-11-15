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
 * - {@link ELEMENT_PSET} on each checked element: outcome and its numbers,
 *   plus what the outcome means, the screening caveat, the attribution and the
 *   dataset date, and the name of the site set, so a payload read on its own
 *   still carries them.
 *
 * The shape matches `PropertySetDef` of `@ifc-lite/create` structurally
 * (`Name`, `Properties[{ Name, NominalValue, Type }]`). Lengths are converted
 * to the model's project length unit, because a writer emits an
 * `IfcLengthMeasure` value as given. Absent values are omitted, never written
 * as zero.
 */

import type { CandidateResult, FloodCheckResult } from './check/check.js';
import { SITE_PSET } from './check/wording.js';
import { buildingLabel } from './model/facts.js';
import type { HazardClassDefinition } from './types.js';

export { SITE_PSET };
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
    .text('CaveatDE', result.caveat.de)
    .text('CaveatEN', result.caveat.en)
    .label('TerrainVerticalReference', result.terrainVerticalReference)
    .text('TerrainVerticalCrs', result.verticalDatum.terrainCrs, 'IfcIdentifier')
    .label('VerticalDatumBasis', result.verticalDatum.basis)
    .label('FootprintSource', result.footprintSource)
    .bool('FootprintPartial', result.footprintPartial)
    .label('FootprintQuality', result.footprintQuality)
    .label('CheckedBuilding', result.buildingScope.checked ? buildingLabel(result.buildingScope.checked) : null)
    .text('BuildingsNotChecked', result.buildingScope.notChecked.map((b) => `${buildingLabel(b)}: ${b.candidatesNotChecked}`).join(' | '))
    .int('CountElementsNotChecked', result.buildingScope.notChecked.reduce((n, b) => n + b.candidatesNotChecked, 0))
    .label('GroundStoreyBasis', result.groundStorey.basis)
    .length('GroundStoreyLevel', result.groundStorey.level)
    .label('HeightPlausibilityStatus', result.heightPlausibility.status)
    .text('HeightPlausibilityBasis', result.heightPlausibility.statement)
    .length('TerrainMinNearBuilding', result.heightPlausibility.terrainMin)
    .length('TerrainMaxNearBuilding', result.heightPlausibility.terrainMax)
    .length('HeightPlausibilityBelow', result.heightPlausibility.below)
    .length('HeightPlausibilityAbove', result.heightPlausibility.above)
    .label('HeightReferenceStatus', result.heightReference.status)
    .text('HeightReferenceUnconfirmedBecause', result.heightReference.unconfirmedBecause.join(' | '))
    .length('HeightReferenceEntryTolerance', result.heightReference.entryAbove)
    .length('HeightReferenceAllowance', result.heightReference.allowance)
    .int('HeightReferenceEntriesChecked', result.heightReference.entries.length)
    .text('ResidualRiskEN', result.heightReference.residualRisk.en)
    .text('ResidualRiskDE', result.heightReference.residualRisk.de)
    .length('ClearanceMargin', result.margin.margin)
    .text('ClearanceMarginBasis', result.margin.statement)
    .length('GeoreferenceVerticalUncertainty', result.margin.georeferenceVerticalUncertainty)
    .label('GeoreferenceVerticalUncertaintyBasis', result.margin.georeferenceBasis)
    .length('TerrainVerticalAccuracy', result.margin.terrainAccuracy)
    .length('RasterCellSize', result.parameters.rasterCellSize)
    .label('RingDistances', result.parameters.ringDistances.map((d) => `${d} m`).join(', '))
    .length('MinOutsideDistance', result.parameters.minOutsideDistance)
    .length('AnchorTolerance', result.parameters.anchorTolerance)
    .bool('RasterEmpty', result.layerCheck.rasterEmpty)
    .label('OtherBuildingsSource', result.otherBuildings.provenance?.source ?? 'none supplied')
    .bool('OtherBuildingsComplete', result.otherBuildings.complete);
  if (result.layerCheck.confirmation) {
    b.bool('LayerRenderingConfirmed', result.layerCheck.confirmationApplies)
      .text('LayerRenderingCheck', `${result.layerCheck.confirmation.detail} (${result.layerCheck.confirmation.requestUrl})`)
      .label('LayerRenderingCheckedAt', result.layerCheck.confirmation.retrievedAt);
  }
  for (const [outcome, count] of Object.entries(result.summary)) {
    b.int(`Count_${outcome.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase())}`, count);
  }
  b.int('CountReachableBelowGroundSpaces', result.reachableBelowGround.length);
  // Results plus skipped equals walked, checkable from this set alone (the element sets are the results).
  if (result.coverage) b.int('CountElementsWalked', result.coverage.walked).int('CountElementsSkipped', result.coverage.skipped);
  // Elements only, so the counts sum to CountElementsSkipped; footprint sources and storeys have their own fields.
  const list = (entries: FloodCheckResult['skipped']) => {
    const byReason = new Map<string, number>();
    for (const s of entries) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    return [...byReason].map(([reason, n]) => `${n}× ${reason}`).join(' | ');
  };
  b.text('ElementsSkippedByReason', list(result.skipped.filter((s) => s.stage === undefined)));
  const sources = result.skipped.filter((s) => s.stage === 'footprint-source');
  b.int('CountFootprintSourcesNotRead', sources.length).text('FootprintSourcesNotRead', sources.map((s) => `${s.ifcClass} #${s.expressId}: ${s.reason}`).join(' | '));
  const storeys = result.skipped.filter((s) => s.stage === 'storey');
  if (storeys.length > 0) b.text('StoreysSkipped', storeys.map((s) => `#${s.expressId}: ${s.reason}`).join(' | '));
  return { Name: SITE_PSET, Properties: b.props };
}

/** The per-element set: outcome, what it means, every number behind it, and the caveat and source it must carry. */
export function elementPropertySet(r: CandidateResult, result: FloodCheckResult): FloodPropertySet {
  const c = r.comparison;
  const cls = r.hazardClass;
  const d = r.drivingSample;
  const b = new Builder(result.lengthUnitScale)
    .label('Outcome', r.outcome)
    .text('OutcomeMeaningEN', r.meaning.en)
    .text('OutcomeMeaningDE', r.meaning.de)
    .text('CaveatEN', r.caveat.en)
    .text('CaveatDE', r.caveat.de)
    .label('UnclassifiedReason', r.unclassifiedReason)
    .label('Category', r.candidate.category)
    .label('SelectedBecause', r.candidate.selectedBecause)
    .label('HazardClass', cls?.id)
    .length('ClassLowerBound', cls?.lowerBound)
    .length('ClassUpperBound', cls?.upperBound);
  if (cls) b.bool('ClassOpenEnded', cls.upperBound === null);
  b.label('ClassesFound', r.classesFound.join(', '))
    .length('ElementLevel', r.candidate.level)
    .label('LevelBasis', r.candidate.levelBasis)
    .bool('LevelIsUpperEstimate', r.candidate.levelIsUpperEstimate)
    .length('ComparedLevel', d?.level)
    .length('TerrainHeight', r.terrainHeight)
    .length('WaterSurfaceLowerBound', c?.surfaceLowerBound)
    .length('WaterSurfaceUpperBound', c?.surfaceUpperBound)
    .length('LevelAboveSurfaceLowerBound', c?.levelAboveSurfaceLowerBound)
    .length('LevelAboveSurfaceUpperBound', c?.levelAboveSurfaceUpperBound)
    .length('ClearanceMargin', r.clearanceMargin)
    .label('DrivingSample', d ? `E ${d.point.x.toFixed(2)}, N ${d.point.y.toFixed(2)} (${result.crs})` : null)
    .int('SamplesCompared', r.samplesCompared)
    .int('SamplesOutsideFootprint', r.samples.planned - r.samples.insideFootprint)
    .int('SamplesUnreadable', r.samples.byReading.unclassified + r.samples.byReading.outside + r.samples.byReading['outside-coverage'])
    .length('AnchorOffset', r.anchorOffset)
    .text('FavourableWithheldBecause', r.favourableWithheldBecause.join(' | '))
    .text('ResidualRiskEN', r.residualRisk.en)
    .text('ResidualRiskDE', r.residualRisk.de)
    .text('Notes', r.notes.join(' | '))
    .text('Dataset', result.provenance.datasetId, 'IfcIdentifier')
    .label('DatasetDate', result.provenance.datasetDate)
    .label('RetrievedAt', result.provenance.retrievedAt)
    .text('Attribution', result.provenance.attribution)
    .label('SitePropertySet', SITE_PSET);
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
