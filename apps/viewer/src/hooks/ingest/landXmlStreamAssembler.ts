/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Strict, bounded reassembly of one Rust LandXML surface fragment stream. */

export const MAX_LANDXML_ASSEMBLED_COMPONENT_BYTES = 8 * 1024 * 1024;

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

interface PendingPayload {
  component: LandXmlSurfaceStreamComponent;
  nextSequence: number;
  chunks: Uint8Array[];
  bytes: number;
}

const ORDER: readonly LandXmlSurfaceStreamComponent[] = [
  'start', 'points', 'canonical_vertices', 'source_data_points', 'faces',
  'boundaries', 'breaklines', 'contours', 'end',
];

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`LandXML stream emitted an invalid ${context}`);
  }
  return value as Record<string, unknown>;
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (!Array.isArray(value) || value.some((byte) => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('LandXML stream emitted an invalid UTF-8 payload');
  }
  return Uint8Array.from(value);
}

function payload(chunks: readonly Uint8Array[], bytesLength: number): unknown {
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

/**
 * Owns one in-progress surface. A caller transfers each returned surface into
 * its provisional renderer transaction before feeding more source input.
 */
export class LandXmlSurfaceFragmentAssembler {
  private sourceId: string | null = null;
  private surface: LandXmlAssembledSurface | null = null;
  private stage = 0;
  private pending: PendingPayload | null = null;

  get pendingBytes(): number { return this.pending?.bytes ?? 0; }

  get hasPendingSurface(): boolean { return this.surface !== null || this.pending !== null; }

  push(fragment: LandXmlSurfaceStreamFragment): LandXmlAssembledSurface | null {
    if (!ORDER.includes(fragment.component) || !Number.isInteger(fragment.sequence) || fragment.sequence < 0) {
      throw new Error('LandXML stream emitted an invalid surface fragment envelope');
    }
    if (this.sourceId !== null && fragment.source_id !== this.sourceId) {
      throw new Error('LandXML stream interleaved source surface fragments');
    }
    if (this.pending === null) {
      if (fragment.sequence !== 0) throw new Error('LandXML stream started a component at a nonzero sequence');
      if (fragment.component === 'start') {
        if (this.surface !== null) throw new Error('LandXML stream started a surface before ending the prior surface');
        this.sourceId = fragment.source_id;
        this.stage = 0;
      } else if (this.surface === null) {
        throw new Error('LandXML stream emitted a surface component before Start');
      }
      const componentStage = ORDER.indexOf(fragment.component);
      if (componentStage < this.stage) {
        throw new Error(`LandXML stream emitted ${fragment.component} out of source order`);
      }
      if (fragment.component === 'end') {
        if (fragment.continued || bytes(fragment.payload_utf8).byteLength !== 0) {
          throw new Error('LandXML stream emitted an invalid End fragment');
        }
        const complete = this.surface;
        this.reset();
        return complete;
      }
      this.pending = {
        component: fragment.component,
        nextSequence: 0,
        chunks: [],
        bytes: 0,
      };
    }
    const pending = this.pending;
    if (pending.component !== fragment.component || pending.nextSequence !== fragment.sequence) {
      throw new Error('LandXML stream fragment continuation sequence is invalid');
    }
    const chunk = bytes(fragment.payload_utf8);
    pending.bytes += chunk.byteLength;
    if (pending.bytes > MAX_LANDXML_ASSEMBLED_COMPONENT_BYTES) {
      throw new Error('LandXML stream component exceeds its bounded assembly limit');
    }
    pending.chunks.push(chunk);
    pending.nextSequence++;
    if (fragment.continued) return null;
    const value = payload(pending.chunks, pending.bytes);
    this.pending = null;
    this.apply(pending.component, value);
    return null;
  }

  abort(): void { this.reset(); }

  private apply(component: Exclude<LandXmlSurfaceStreamComponent, 'end'>, value: unknown): void {
    if (component === 'start') {
      const start = object(value, 'surface Start payload');
      this.surface = {
        source_id: this.sourceId ?? '',
        ordinal: start.ordinal,
        source_path: start.source_path,
        properties: start.properties,
        definition_properties: start.definition_properties,
        name: start.name,
        kind: start.kind,
        render_state: start.render_state,
        topology_origin: start.topology_origin,
        terrain_diagnostic: start.terrain_diagnostic,
        hidden_face_count: start.hidden_face_count,
        points: [], canonical_vertices: [], source_data_points: [], faces: [], face_source_ids: [],
        face_visibility: [], boundaries: [], breaklines: [], contours: [],
      };
      this.stage = 1;
      return;
    }
    const surface = this.surface;
    if (surface === null) throw new Error('LandXML stream lost its surface Start payload');
    switch (component) {
      case 'points': surface.points.push(value); break;
      case 'canonical_vertices': surface.canonical_vertices.push(value); break;
      case 'source_data_points': surface.source_data_points.push(value); break;
      case 'faces': {
        const face = object(value, 'face payload');
        surface.faces.push(face.ids);
        surface.face_source_ids.push(face.source_id);
        surface.face_visibility.push(face.visible);
        break;
      }
      case 'boundaries': surface.boundaries.push(value); break;
      case 'breaklines': surface.breaklines.push(value); break;
      case 'contours': surface.contours.push(value); break;
    }
    const componentStage = ORDER.indexOf(component);
    if (componentStage > this.stage) this.stage = componentStage;
  }

  private reset(): void {
    this.sourceId = null;
    this.surface = null;
    this.stage = 0;
    this.pending = null;
  }
}
