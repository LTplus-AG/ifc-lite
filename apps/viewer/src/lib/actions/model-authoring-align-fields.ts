/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { ALIGN_MODES, type AlignMode } from '@ifc-lite/create';
import type { ExistingElement } from './model-authoring';
import { parseNativePlacement, type NativePlacement } from './model-authoring-placement';
export interface AlignmentOp {
  op: 'element.align'; reference: ExistingElement; targets: ExistingElement[]; mode: AlignMode;
  expected: { reference: NativePlacement; targets: NativePlacement[] };
}
export function parseAlignment(value: Record<string, unknown>, at: string, existing: (value: unknown, at: string) => ExistingElement): AlignmentOp {
  if (typeof value.mode !== 'string' || !ALIGN_MODES.some(mode => mode === value.mode)) throw new Error(`${at}: mode must be a native Align mode`);
  if (!Array.isArray(value.targets) || !value.targets.length || value.targets.length > 10000) throw new Error(`${at}: native Align requires 1..10000 targets`);
  const expected = value.expected;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error(`${at}: copy every nativePlacement expected snapshot`);
  const r = expected as Record<string, unknown>;
  if (!Array.isArray(r.targets) || r.targets.length !== value.targets.length) throw new Error(`${at}: expected targets must match the complete requested population`);
  return { op: 'element.align', reference: existing(value.reference, `${at} reference`),
    targets: value.targets.map((v, i) => existing(v, `${at} target ${i + 1}`)), mode: value.mode as AlignMode,
    expected: { reference: parseNativePlacement(r.reference, `${at} expected reference`),
      targets: r.targets.map((v, i) => parseNativePlacement(v, `${at} expected target ${i + 1}`)) } };
}
