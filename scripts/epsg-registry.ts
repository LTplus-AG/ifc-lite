/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EpsgIndexEntry as BundledEpsgIndexEntry } from '../packages/data/src/epsg-types.js';
import { PROJ4_OVERRIDES } from './epsg-proj4-overrides.js';

type RegistryLink = {
  rel?: string;
  href?: string;
};

export type RegistrySummary = {
  Code: number;
  Name: string;
  Type?: string;
  Area?: string;
  Remarks?: string;
  Deprecated?: boolean;
  Superseded?: boolean;
  Links?: RegistryLink[];
};

type RegistryUsage = {
  Name?: string;
  ScopeDetails?: string;
};

type RegistryAlias = {
  Alias?: string;
};

type RegistryNamedRef = {
  Code?: number;
  Name?: string;
};

export type RegistryDetail = {
  Code: number;
  Name: string;
  Kind?: string;
  Usage?: RegistryUsage[];
  Alias?: RegistryAlias[];
  Datum?: RegistryNamedRef;
  DatumEnsemble?: RegistryNamedRef;
  BaseCoordRefSystem?: RegistryNamedRef;
  Projection?: RegistryNamedRef;
  Conversion?: RegistryNamedRef;
  CoordSys?: RegistryNamedRef;
  HorizontalCrs?: RegistryNamedRef;
  VerticalCrs?: RegistryNamedRef;
};

export type RegistryPage = {
  Results: RegistrySummary[];
  Count: number;
  Page: number;
  PageSize: number;
  TotalResults: number;
};

/** Horizontal component id is retained only while generating the XY definition. */
export type EpsgIndexEntry = BundledEpsgIndexEntry & { horizontalCode?: string };

function normalizeKind(kind: string | undefined): string {
  const value = (kind ?? '').toLowerCase();
  if (value.includes('projected')) return 'Projected';
  if (value.includes('geographic') || value.includes('geodetic')) return 'Geographic';
  if (value.includes('compound')) return 'Compound';
  if (value.includes('vertical')) return 'Vertical';
  if (value.includes('engineering')) return 'Engineering';
  if (value.includes('geocentric')) return 'Geocentric';
  if (value.includes('derived')) return 'Derived';
  return kind?.trim() || 'Unknown';
}

function extractUnit(coordSysName: string | undefined): string {
  if (!coordSysName) return '';
  const match = /UoM:\s*([^.,]+)/i.exec(coordSysName);
  return match?.[1]?.trim() ?? '';
}

function buildSearchText(parts: Array<string | undefined>): string {
  return parts
    .flatMap(part => (part ?? '').split(/\s+/))
    .map(token => token.trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

export function summarizeEntry(summary: RegistrySummary, detail: RegistryDetail): EpsgIndexEntry {
  const usage = detail.Usage?.[0];
  const aliases = (detail.Alias ?? [])
    .map(alias => alias.Alias?.trim() ?? '')
    .filter(Boolean);
  const kind = normalizeKind(detail.Kind ?? summary.Type);

  const datum =
    detail.Datum?.Name?.trim() ??
    detail.DatumEnsemble?.Name?.trim() ??
    detail.BaseCoordRefSystem?.Name?.trim() ??
    detail.HorizontalCrs?.Name?.trim() ??
    detail.VerticalCrs?.Name?.trim() ??
    '';

  const projection = kind === 'Projected'
    ? (detail.Projection?.Name?.trim() ?? detail.Conversion?.Name?.trim() ?? '')
    : '';

  const area = usage?.Name?.trim() || summary.Area?.trim() || '';
  const scope = usage?.ScopeDetails?.trim() || summary.Remarks?.trim() || '';
  const unit = extractUnit(detail.CoordSys?.Name);

  return {
    ...(detail.HorizontalCrs?.Code ? { horizontalCode: String(detail.HorizontalCrs.Code) } : {}),
    code: String(detail.Code),
    name: detail.Name.trim(),
    kind,
    area,
    scope,
    datum,
    projection,
    unit,
    deprecated: Boolean(summary.Deprecated),
    aliases,
    searchText: buildSearchText([
      String(detail.Code),
      detail.Name,
      area,
      scope,
      datum,
      projection,
      unit,
      ...aliases,
    ]),
  };
}

/**
 * Inherit horizontal XY operations before consulting a lossy compound proj4
 * export. Codes in PROJ4_OVERRIDES keep their pinned definition: the override
 * table is the verified one, and inheriting over it would undo it on the next
 * full regeneration.
 */
export function inheritCompoundProj4(entries: EpsgIndexEntry[], source = entries): void {
  const byCode = new Map(source.map(entry => [entry.code, entry]));
  for (const entry of entries) {
    if (entry.kind === 'Compound' && entry.horizontalCode && !PROJ4_OVERRIDES.has(entry.code)) {
      entry.proj4 = byCode.get(entry.horizontalCode)?.proj4 ?? entry.proj4;
    }
  }
}

/** The horizontal relation is generator metadata, not part of the shipped index. */
export function indexJson(entries: EpsgIndexEntry[]): string {
  return JSON.stringify(entries.map(({ horizontalCode: _horizontalCode, ...entry }) => entry));
}
