/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model inspector's per-kind fields (charter #6232, M2.5): which
 * dimensions a kind's defaults carry (the builder parameter names the
 * defaults slice keys them by) and how a length is shown and read back.
 */

import type { TranslationKey } from '@/i18n';
import type { AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';

export type DimParam = 'Thickness' | 'Height' | 'Width' | 'Depth' | 'Length' | 'SillHeight';

export const DIM_LABEL: Readonly<Record<DimParam, TranslationKey>> = {
  Thickness: 'modelInspector.dims.Thickness',
  Height: 'modelInspector.dims.Height',
  Width: 'modelInspector.dims.Width',
  Depth: 'modelInspector.dims.Depth',
  Length: 'modelInspector.dims.Length',
  SillHeight: 'modelInspector.dims.SillHeight',
};

export const KIND_LABEL: Readonly<Record<AuthoredElementKind, TranslationKey>> = {
  wall: 'modelInspector.kind.wall',
  slab: 'modelInspector.kind.slab',
  roof: 'modelInspector.kind.roof',
  plate: 'modelInspector.kind.plate',
  column: 'modelInspector.kind.column',
  beam: 'modelInspector.kind.beam',
  member: 'modelInspector.kind.member',
  door: 'modelInspector.kind.door',
  window: 'modelInspector.kind.window',
  space: 'modelInspector.kind.space',
};

/** The dimensions a new element of each kind is built with (`authoringDefaults.dims`). */
export const DEFAULT_DIMS: Readonly<Record<AuthoredElementKind, readonly DimParam[]>> = {
  wall: ['Thickness', 'Height'],
  slab: ['Width', 'Depth', 'Thickness'],
  roof: ['Width', 'Depth', 'Thickness'],
  plate: ['Width', 'Depth', 'Thickness'],
  column: ['Width', 'Depth', 'Height'],
  beam: ['Width', 'Height'],
  member: ['Width', 'Height'],
  door: ['Width', 'Height'],
  window: ['Width', 'Height', 'SillHeight'],
  space: ['Width', 'Depth', 'Height'],
};

/** The unit symbol after a length field: a symbol, not copy, so it is not translated. */
export const METRE_SYMBOL = 'm';

/** Metres for display: millimetre precision, no trailing zeros past the centimetres. */
export function formatMetres(value: number): string {
  if (!Number.isFinite(value)) return '';
  const fixed = value.toFixed(3);
  return fixed.endsWith('0') ? value.toFixed(2) : fixed;
}

/** A typed length in metres (a comma decimal works too), or null when it is not a positive number. */
export function parseMetres(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(value) && value > 0 ? value : null;
}
