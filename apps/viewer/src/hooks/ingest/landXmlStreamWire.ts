/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Common, bounded primitives for the Rust LandXML stream wire. */

/** One source component/metadata record may span events, never host credit. */
export const MAX_LANDXML_ASSEMBLED_COMPONENT_BYTES = 512 * 1024;

export type LandXmlSurfaceStreamComponent =
  | 'start' | 'points' | 'canonical_vertices' | 'source_data_points'
  | 'faces' | 'boundaries' | 'breaklines' | 'contours' | 'end';

export interface LandXmlSurfaceStreamFragment {
  source_id: string;
  component: LandXmlSurfaceStreamComponent;
  sequence: number;
  continued: boolean;
  payload_utf8: unknown;
}

export interface LandXmlAssembledSurface {
  source_id: string;
  ordinal: unknown;
  source_path: unknown;
  properties: unknown;
  definition_properties: unknown;
  name: unknown;
  kind: unknown;
  render_state: unknown;
  topology_origin: unknown;
  terrain_diagnostic: unknown;
  hidden_face_count: unknown;
  points: unknown[];
  canonical_vertices: unknown[];
  source_data_points: unknown[];
  faces: unknown[];
  face_source_ids: unknown[];
  face_visibility: unknown[];
  boundaries: unknown[];
  breaklines: unknown[];
  contours: unknown[];
}

export function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`LandXML stream emitted an invalid ${context}`);
  }
  return value as Record<string, unknown>;
}

export function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (!Array.isArray(value) || value.some((byte) => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('LandXML stream emitted an invalid UTF-8 payload');
  }
  return Uint8Array.from(value);
}

export function payload(chunks: readonly Uint8Array[], bytesLength: number): unknown {
  const joined = new Uint8Array(bytesLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`LandXML stream emitted malformed JSON payload: ${message}`);
  }
}
