/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface CompressionRequest { id: number; buffer: ArrayBuffer }
export type CompressionResponse =
  | { id: number; buffer: ArrayBuffer; compressed: boolean }
  | { id: number; error: string };

export function isCompressionRequest(value: unknown): value is CompressionRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<CompressionRequest>;
  return Number.isSafeInteger(request.id) && request.id! > 0 && request.buffer instanceof ArrayBuffer;
}
