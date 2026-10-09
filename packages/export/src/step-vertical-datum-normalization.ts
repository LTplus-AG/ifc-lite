/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readStepSlots } from './step-argument-parser.js';
import { attrIndex, stepSourceSchema } from './subset-entity-reader.js';
import type { ExportPass } from './step-export-types.js';

/** EGM2008 height: the global geoid model Cesium ion was observed to apply. */
const EGM2008_HEIGHT = 'EPSG:3855';

// Names of geodetic (ellipsoidal) datums: their heights need no geoid.
const ELLIPSOIDAL = /ellipso|wgs\s*-?\s*84|grs\s*-?\s*80|etrs\s*-?\s*89|itrf/i;
const EPSG_CODE = /^\s*EPSG\s*:\s*\d+\s*$/i;

/** Count an emitted georeferencing edit once in the export's modification ledger. */
export function recordGeoreferencingEdit(pass: ExportPass, id: number): void {
  // Newly created entities already contribute to newEntityCount; source
  // entities count once even if an earlier session edit changed them too.
  if (!pass.effective.isOverlayCreated(id) && pass.effective.has(id)) {
    pass.modifications.nominate(id, 'georeferencing');
    pass.modifications.recordEmitted(id, 'georeferencing');
  }
}

/**
 * Write a free-text `IfcProjectedCRS.VerticalDatum` that names a sea-level
 * datum (e.g. 'EVRS2007') as EGM2008 height on the *emitted* model (#7356).
 *
 * Cesium ion applies a geoid only for vertical CRS codes it has a model for:
 * live uploads shifted heights by the local EGM2008 separation for
 * 'EPSG:3855', and not at all for 'EVRS2007', 'EPSG:5621' or a compound
 * name, which left a sea-level model one geoid separation (48 m) too low.
 * Explicit EPSG codes are the author's statement and stay as written, as do
 * ellipsoidal datum names. The authored datum's own offset from EGM2008
 * (typically decimetres) remains; heights themselves are never rewritten.
 */
export function normalizeVerticalDatumToEgm2008(pass: ExportPass): void {
  const slot = attrIndex('IFCPROJECTEDCRS', 'VerticalDatum', stepSourceSchema(pass.sourceSchema));
  if (slot < 0) return;
  for (let index = 0; index < pass.entities.length; index++) {
    const line = pass.entities[index];
    const prefix = /^#([0-9]+)\s*=\s*IFCPROJECTEDCRS\s*\(/i.exec(line);
    if (!prefix) continue;
    const record = readStepSlots(line);
    const token = record?.slots[slot]?.trim();
    const text = token && /^'.*'$/s.test(token) ? token.slice(1, -1) : undefined;
    if (!record || !text?.trim() || EPSG_CODE.test(text) || ELLIPSOIDAL.test(text)) continue;
    const slots = record.slots.map(value => value.trim());
    slots[slot] = `'${EGM2008_HEIGHT}'`;
    pass.entities[index] = `${record.prefix}${slots.join(',')}${record.suffix}`;
    recordGeoreferencingEdit(pass, Number(prefix[1]));
  }
}
