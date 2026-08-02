/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Typed reader for `SpacePlateHandle` edit rejections.
 *
 * The Rust binding throws a `js_sys::Error` whose `name` is a STABLE code (one
 * of `EditErrorCode`) and whose `message` is human prose — so callers switch on
 * the code for control flow and show the message to the user, instead of
 * pattern-matching the prose. See `rust/wasm-bindings/src/api/space_plate.rs`.
 */

/** The stable `EditError` variants the engine can reject an edit with. */
export type EditErrorCode =
  | 'StaleHandle'
  | 'VerticesNotOnFace'
  | 'DegenerateCut'
  | 'BordersExterior'
  | 'BridgeEdge'
  | 'VertexNotDissolvable'
  | 'InvalidPolygon';

const CODES: ReadonlySet<string> = new Set<EditErrorCode>([
  'StaleHandle',
  'VerticesNotOnFace',
  'DegenerateCut',
  'BordersExterior',
  'BridgeEdge',
  'VertexNotDissolvable',
  'InvalidPolygon',
]);

export interface EditError {
  /** The stable engine code, or `null` if this wasn't a recognised edit error. */
  code: EditErrorCode | null;
  /** Human-readable message, safe to surface in the status line. */
  message: string;
}

/** Normalise anything thrown by a `SpacePlateHandle` edit into `{ code, message }`. */
export function editError(err: unknown): EditError {
  if (err instanceof Error) {
    const code = CODES.has(err.name) ? (err.name as EditErrorCode) : null;
    return { code, message: err.message || err.name || 'Edit failed' };
  }
  // A thrown string / unknown value — strip a leading "Word:" code prefix so a
  // legacy/raw rejection still reads cleanly.
  return { code: null, message: String(err).replace(/^\w+:\s*/, '') };
}
