/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `ifc-lite gym` mutation-op vocabulary: parsing/validation of raw
 * JSON ops and their application to a `MutablePropertyView`.
 *
 * Parsing is deliberately separate from application so a `step` batch can
 * be validated as a whole before any op touches session state - the
 * protocol promises atomic batches (a batch either fully applies or leaves
 * the session unchanged).
 */

import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';

/** A single mutation op, applied cumulatively across `step` calls. */
export type GymOp =
  | { op: 'setProperty'; expressId: number; psetName: string; propName: string; value: string | number | boolean | null }
  | { op: 'setAttribute'; expressId: number; attrName: string; value: string }
  | { op: 'deleteProperty'; expressId: number; psetName: string; propName: string };

function inferValueType(value: unknown): PropertyValueType {
  if (typeof value === 'boolean') return PropertyValueType.Boolean;
  if (typeof value === 'number') return Number.isInteger(value) ? PropertyValueType.Integer : PropertyValueType.Real;
  return PropertyValueType.String;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`op field "${field}" must be a non-empty string`);
  }
  return value;
}

function requireExpressId(value: unknown): number {
  if (!isFiniteNumber(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error('op field "expressId" must be a positive integer');
  }
  return value;
}

/**
 * Validate one raw JSON op into a typed {@link GymOp}. Throws a plain Error
 * on anything malformed; nothing is applied. The caller turns the throw
 * into a structured `{type:"error"}` line rather than crashing the process.
 */
export function parseOp(raw: unknown): GymOp {
  if (typeof raw !== 'object' || raw === null || typeof (raw as { op?: unknown }).op !== 'string') {
    throw new Error('each op needs a string "op" field');
  }
  const op = raw as GymOp;
  switch (op.op) {
    case 'setProperty': {
      const expressId = requireExpressId(op.expressId);
      const psetName = requireString(op.psetName, 'psetName');
      const propName = requireString(op.propName, 'propName');
      const value = op.value;
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error('op field "value" must be a string, number, boolean, or null');
      }
      return { op: 'setProperty', expressId, psetName, propName, value };
    }
    case 'setAttribute': {
      const expressId = requireExpressId(op.expressId);
      const attrName = requireString(op.attrName, 'attrName');
      const value = requireString(op.value, 'value');
      return { op: 'setAttribute', expressId, attrName, value };
    }
    case 'deleteProperty': {
      const expressId = requireExpressId(op.expressId);
      const psetName = requireString(op.psetName, 'psetName');
      const propName = requireString(op.propName, 'propName');
      return { op: 'deleteProperty', expressId, psetName, propName };
    }
    default:
      throw new Error(`Unsupported op "${(op as { op: string }).op}" (v0 supports setProperty, setAttribute, deleteProperty)`);
  }
}

/** Apply one already-validated op to the mutation overlay. */
export function applyOp(view: MutablePropertyView, op: GymOp): void {
  switch (op.op) {
    case 'setProperty':
      view.setProperty(op.expressId, op.psetName, op.propName, op.value, inferValueType(op.value));
      return;
    case 'setAttribute':
      view.setAttribute(op.expressId, op.attrName, op.value);
      return;
    case 'deleteProperty':
      view.deleteProperty(op.expressId, op.psetName, op.propName);
      return;
  }
}
