/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The refusal vocabulary of the storey edits (#9013). A refusal is decided
 * while planning, before anything is written, and carries a stable `code`
 * plus the parameters a UI needs to translate it; `message` is the English
 * text the SDK, MCP and CLI report as is.
 */

/** Storeys closer than this (metres) are refused as zero spacing. */
export const MIN_STOREY_SPACING = 0.001;

export type StoreyRefusalCode =
  | 'notFound'
  | 'invalidValue'
  | 'spacing'
  | 'crossing'
  | 'topStorey'
  | 'unplaced'
  | 'unreadablePlacement'
  | 'sharedPlacement'
  | 'notEmpty'
  | 'invalidTarget'
  | 'onlyStorey'
  | 'dependent'
  /** A reviewed plan no longer matches the model: review the edit again. */
  | 'stale'
  /** The storey holds more products than one plan may write. */
  | 'tooLarge';

export interface StoreyRefusal {
  readonly code: StoreyRefusalCode;
  readonly message: string;
  /** The elements the refusal is about, for selection and listing. */
  readonly elementIds?: readonly number[];
  readonly params?: Readonly<Record<string, string | number>>;
}

/** A non-blocking note: something the edit leaves as it is, and why. */
export interface StoreyNotice {
  readonly code: string;
  readonly message: string;
  readonly elementIds: readonly number[];
}

/** Thrown by an apply function when the plan it re-reads is refused. Nothing was written. */
export class StoreyEditRefusedError extends Error {
  constructor(readonly refusals: readonly StoreyRefusal[]) {
    super(refusals.map((refusal) => refusal.message).join('; '));
    this.name = 'StoreyEditRefusedError';
  }
}

/** `+3.00 m`, `−0.40 m`, `±0.00 m`: the storey picker's convention. */
export function describeElevation(metres: number): string {
  const rounded = Math.round(metres * 100) / 100;
  if (rounded === 0) return '±0.00 m';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(2)} m`;
}

export function describeLength(metres: number): string {
  return `${(Math.round(metres * 100) / 100).toFixed(2)} m`;
}
