/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-element x per-zone table (issue #2508 item 3), which is the direct
 * answer to the complaint that opened #1763:
 *
 * > you can't get clean quantities per zone without a lot of manual work in
 * > Excel or similar.
 *
 * So the deliverable is a file that opens in Excel and pivots, not a panel.
 *
 * ## Long, not wide
 *
 * ONE ROW PER (element, zone) pair rather than one row per element with a
 * column per zone. A wide table's columns change every time a zone is added,
 * renamed or deleted, so every saved pivot, formula and Power Query step
 * against it breaks; and a straddler - the population this feature exists for -
 * is exactly the row that would need several columns filled. Long format
 * pivots to wide in one step in any spreadsheet, and the reverse is a manual
 * unpivot.
 *
 * An element that reaches no zone of the set is not in the table at all. An
 * element the volumes could not be established for IS, with an empty volume and
 * the reason stated, because "this wall is in Takt B and we could not measure
 * it" is a different fact from "this wall is not in Takt B", and a total that
 * silently omits the first is the kind of number #2508's verification bar
 * exists to stop.
 *
 * Pure: the numbers arrive already resolved (`hooks/zoneFacts.ts`), which is
 * the same call the pset write-back makes. Nothing here recomputes a volume.
 */

import { volumeBasisLabel, type VolumeBasis } from './volume-basis.js';
import type { ElementZoneFacts, WriteBackRefusal } from './writeback.js';

/** One row: what one element contributes to one zone. */
export interface ZoneTableRow {
  GlobalId: string;
  ExpressId: number;
  Model: string;
  IfcType: string;
  Name: string;
  ZoneSet: string;
  Zone: string;
  /** The zone holding the element's centroid, which is what the Lists column
   *  and the pset call its zone. Repeated on every row of the element so a
   *  filtered sheet keeps it. */
  HomeZone: string;
  Straddles: boolean;
  /** Cubic metres of this element in THIS zone, or null when unmeasurable. */
  VolumeM3: number | null;
  /** This zone's share of the element, 0..1, or null. Kept beside the volume
   *  because a fraction survives a unit disagreement and a volume does not. */
  Fraction: number | null;
  /** The element's whole volume on this basis, so a reader can check the rows
   *  against it without a second pass. */
  ElementVolumeM3: number | null;
  Basis: string;
  /** Named quantity the magnitudes came from (`NetVolume`), or empty on the
   *  mesh basis where there is no declared quantity behind them. */
  Quantity: string;
  /** Why `VolumeM3` is empty. Empty string when it is not. */
  Unavailable: string;
}

/** Column order, which is also the CSV header order. Fixed here so the CSV and
 *  the Parquet schema cannot drift apart. */
export const ZONE_TABLE_COLUMNS: ReadonlyArray<keyof ZoneTableRow> = [
  'GlobalId', 'ExpressId', 'Model', 'IfcType', 'Name',
  'ZoneSet', 'Zone', 'HomeZone', 'Straddles',
  'VolumeM3', 'Fraction', 'ElementVolumeM3', 'Basis', 'Quantity', 'Unavailable',
];

/** Everything about an element that the facts do not carry. */
export interface ZoneTableElement {
  globalId: string;
  expressId: number;
  modelName: string;
  ifcType: string;
  name: string;
}

/** A refusal as a sentence, because the column is read by a person in a
 *  spreadsheet rather than switched on by code. Mirrors the pset's own
 *  `VolumeUnavailable` wording, so the file and the model agree. */
export function refusalText(refusal: WriteBackRefusal): string {
  switch (refusal) {
    case 'no-geometry': return 'no geometry loaded for this element';
    case 'no-declared-quantity': return 'the model declares no quantity on this basis';
    case 'unproved-solid': return 'the mesh is not a proven closed solid';
    case 'overlapping-zones': return 'the zones of this set overlap, so shares would double-count';
    case 'rescaled-by-alignment': return 'federation alignment rescaled this model';
    default: return refusal;
  }
}

/**
 * One element's facts to rows, one per zone it reaches.
 *
 * A zone with no measured share still gets its row: the element reaches it (the
 * assignment says so), and dropping the row would make the element look absent
 * from a zone it is demonstrably in.
 */
export function zoneTableRows(
  element: ZoneTableElement,
  facts: ElementZoneFacts,
  zoneSetName: string,
  basis: VolumeBasis,
): ZoneTableRow[] {
  const shares = new Map(facts.shares.map((s) => [s.zoneName, s.valueM3]));
  const total = facts.shares.reduce((sum, s) => sum + s.valueM3, 0) + facts.outsideM3;
  const unavailable = facts.refusal ? refusalText(facts.refusal) : '';

  return facts.touchedZoneNames.map((zoneName) => {
    const value = shares.get(zoneName);
    const measured = value !== undefined && Number.isFinite(value);
    return {
      GlobalId: element.globalId,
      ExpressId: element.expressId,
      Model: element.modelName,
      IfcType: element.ifcType,
      Name: element.name,
      ZoneSet: zoneSetName,
      Zone: zoneName,
      HomeZone: facts.homeZoneName ?? '',
      Straddles: facts.straddles,
      VolumeM3: measured ? value : null,
      // Guarded against a zero total: an element whose whole volume is 0 has no
      // meaningful fraction, and 0/0 would put NaN in a spreadsheet.
      Fraction: measured && total > 0 ? value / total : null,
      ElementVolumeM3: measured || facts.shares.length > 0 ? total : null,
      Basis: volumeBasisLabel(basis),
      Quantity: facts.quantityName ?? '',
      Unavailable: measured ? '' : unavailable,
    };
  });
}

/**
 * RFC 4180 CSV.
 *
 * Quoting is not optional here: an IFC `Name` routinely contains a comma
 * ("Basic Wall:SW 200,0"), German decimal commas appear in type names, and a
 * zone a user called `Takt "A"` is legal. A file that shifts every column right
 * on one row is worse than no file, because the shift is invisible until
 * someone sums the wrong column.
 */
export function toCsv(rows: readonly ZoneTableRow[], delimiter = ','): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
    return /["\n\r]|^\s|\s$/.test(text) || text.includes(delimiter)
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  };
  const lines = [ZONE_TABLE_COLUMNS.join(delimiter)];
  for (const row of rows) {
    lines.push(ZONE_TABLE_COLUMNS.map((column) => cell(row[column])).join(delimiter));
  }
  // Trailing newline: POSIX text files end with one, and its absence makes
  // `cat a.csv b.csv` silently join two rows.
  return `${lines.join('\n')}\n`;
}

/** The same rows as columns, for the Parquet writer. Column-major because
 *  that is what Arrow wants, and building it here keeps the two formats on one
 *  definition of the schema. */
export function toColumns(rows: readonly ZoneTableRow[]): Record<string, unknown[]> {
  const columns: Record<string, unknown[]> = {};
  for (const column of ZONE_TABLE_COLUMNS) {
    columns[column] = rows.map((row) => row[column]);
  }
  return columns;
}

/** Column names that must stay Float64 in Parquet even when every value in a
 *  given export happens to be whole. */
export const ZONE_TABLE_FLOAT_COLUMNS: ReadonlySet<string> = new Set([
  'VolumeM3', 'Fraction', 'ElementVolumeM3',
]);
