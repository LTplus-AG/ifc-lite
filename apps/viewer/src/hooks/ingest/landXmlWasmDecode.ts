/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Strict decoders shared by the LandXML WASM document adapters. */

export function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`LandXML WASM returned an invalid ${context}`);
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`LandXML WASM returned an invalid ${context}`);
  return value;
}

export function finite(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`LandXML WASM returned an invalid ${context}`);
  }
  return value;
}

export function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`LandXML WASM returned an invalid ${context}`);
  return value;
}

export function properties(value: unknown, context: string): Record<string, string> {
  const raw = record(value, context);
  return Object.fromEntries(Object.entries(raw).map(([name, property]) => [name, string(property, `${context} ${name}`)]));
}

export function nullableString(value: unknown, context: string): string | null {
  // `serde_wasm_bindgen` omits `None` struct fields rather than always
  // materialising them as JavaScript `null`.
  return value === null || value === undefined ? null : string(value, context);
}

export function nullableFinite(value: unknown, context: string): number | null {
  return value === null || value === undefined ? null : finite(value, context);
}

export function strings(value: unknown, context: string): string[] {
  return array(value, context).map((entry, index) => string(entry, `${context} ${index}`));
}
