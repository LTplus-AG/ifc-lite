/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Incremental, credit-bounded geometry preflight for the LandXML cursor. */

import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MeshData } from '@ifc-lite/geometry';
import { createCoordinateInfo, createEmptyBounds, type Bounds3D } from '../../utils/localParsingUtils.js';
import { LandXmlPipeComponentCursor, MAX_LANDXML_PIPE_MESHES } from './landXmlPipeGeometry.js';
import { pipeNetworks } from './landXmlPipeWasm.js';
import { buildLandXmlSurfaceComponents, fragmentLandXmlGeometryComponent, type LandXmlGeometryPreflight } from './landXmlIngest.js';
import { deriveLandXmlRenderFrameFromMeasurement } from './landXmlRenderFrame.js';
import type { LandXmlAssembledSurface } from './landXmlStreamAssembler.js';
import { readLandXmlTinSurface } from './landXmlWasm.js';
import type { LandXmlTinDocument } from './landXmlSemantics.js';

const MAX_METADATA_RECORD_BYTES = 512 * 1024;

interface StreamUnits {
  linearScaleToMeters: number;
  elevationScaleToMeters: number;
}

/** One source-ordered RTE candidate, released after its acknowledged callback. */
export interface LandXmlPreflightComponent {
  mesh: MeshData;
  /** Monotonic source-surface group; pipes remain individual undefined groups. */
  frameGroup?: number;
}

interface PendingRecord {
  record: string;
  nextSequence: number;
  chunks: Uint8Array[];
  bytes: number;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`LandXML stream emitted an invalid ${context}`);
  }
  return value as Record<string, unknown>;
}

function bytePayload(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (!Array.isArray(value) || value.some((byte) => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('LandXML stream emitted an invalid UTF-8 metadata payload');
  }
  return Uint8Array.from(value);
}

function mergeBounds(target: Bounds3D, source: Bounds3D): void {
  target.min.x = Math.min(target.min.x, source.min.x);
  target.min.y = Math.min(target.min.y, source.min.y);
  target.min.z = Math.min(target.min.z, source.min.z);
  target.max.x = Math.max(target.max.x, source.max.x);
  target.max.y = Math.max(target.max.y, source.max.y);
  target.max.z = Math.max(target.max.z, source.max.z);
}

function decodeUnits(header: unknown): StreamUnits | null {
  const raw = record(header, 'stream header');
  if (raw.units === undefined || raw.units === null) return null;
  const units = record(raw.units, 'stream Units');
  const linear = units.linear_scale_to_meters;
  const elevation = units.elevation_scale_to_meters;
  if (typeof linear !== 'number' || !Number.isFinite(linear) || typeof elevation !== 'number' || !Number.isFinite(elevation)) {
    throw new Error('LandXML stream header has invalid unit scales');
  }
  return { linearScaleToMeters: linear, elevationScaleToMeters: elevation };
}

/**
 * Measures the exact bounded mesh envelope while retaining neither completed
 * terrain surfaces nor plan/alignment documents. Plan and alignment coordinate
 * facts are folded as individual records arrive. Each pipe network is decoded,
 * measured, and released as its own credited record arrives.
 */
export class LandXmlStreamPreflightReducer {
  private units: StreamUnits | null = null;
  private headerSeen = false;
  private componentCount = 0;
  private nextSurfaceFrameGroup = 0;
  private readonly sourceBounds = createEmptyBounds();
  private readonly measurementBounds = createEmptyBounds();
  private dominant: { bounds: Bounds3D; triangles: number } | null = null;
  private pipeHeader: Record<string, unknown> | null = null;
  /** Cursor-only source refusals for the network which follows them. */
  private readonly pendingPipeRefusals: unknown[] = [];
  private emittedPipeMeshes = 0;
  private pending: PendingRecord | null = null;
  private skipped: { record: string; nextSequence: number } | null = null;
  private completed = false;
  private coordinateSystem: LandXmlTinDocument['coordinateSystem'];

  constructor(private readonly componentSink?: (component: LandXmlPreflightComponent) => void | Promise<void>) {}

  onHeader(header: unknown): void {
    if (this.headerSeen) throw new Error('LandXML stream emitted multiple source headers');
    this.headerSeen = true;
    this.units = decodeUnits(header);
  }

  async onSurface(surfaceWire: LandXmlAssembledSurface): Promise<void> {
    if (this.completed) throw new Error('LandXML surface arrived outside preflight');
    const surface = readLandXmlTinSurface(surfaceWire);
    // Preserved-only source records (for example a VOLUME surface) are valid
    // LandXML without Units. They still reach the semantic assembler, but
    // never enter this numeric geometry reducer.
    if (surface.renderState !== 'rendered' || !surface.faceVisibility.some(Boolean)) return;
    const units = this.units;
    if (units === null) throw new Error('LandXML stream emitted renderable geometry without Units');
    for (const point of surface.points) this.addSourcePoint(point.northing, point.easting, point.elevation);
    for (const lines of [surface.boundaries, surface.breaklines]) {
      for (const line of lines) for (const point of line.points) {
        if (point.length === 3) this.addSourcePoint(point[0]!, point[1]!, point[2]!);
      }
    }
    for (const contour of surface.contours) {
      const elevation = contour.properties.elev === undefined ? undefined : Number(contour.properties.elev);
      for (const point of contour.points) this.addSourcePoint(point[0]!, point[1]!, point.length === 3 ? point[2]! : elevation);
    }
    const built = buildLandXmlSurfaceComponents(surface, {
      linearUnit: 'stream', elevationUnit: 'stream', linearScaleToMeters: units.linearScaleToMeters,
      elevationScaleToMeters: units.elevationScaleToMeters,
    }, this.componentCount + 1);
    // Each Rust surface record is delivered exactly once and its components
    // are emitted synchronously before the next record, making this compact
    // ordinal a replayable contiguity witness without retaining source IDs.
    const frameGroup = ++this.nextSurfaceFrameGroup;
    for (const component of built.components) {
      await this.measure(component.bounds, component.mesh.indices.length / 3, component.mesh, frameGroup);
    }
  }

  async onEvent(event: unknown): Promise<void> {
    const envelope = record(event, 'stream event');
    if (envelope.kind !== 'metadata') return;
    const kind = envelope.metadata_kind;
    if (kind === 'header') {
      if (this.pipeHeader !== null) throw new Error('LandXML stream emitted multiple metadata headers');
      const terrain = record(envelope.terrain, 'terrain metadata header');
      const coordinateSystem = terrain.coordinate_system;
      this.coordinateSystem = coordinateSystem === undefined || coordinateSystem === null
        ? undefined
        : (() => {
          const value = record(coordinateSystem, 'coordinate system');
          return {
            ...(typeof value.horizontal_datum === 'string' ? { horizontalDatum: value.horizontal_datum } : {}),
            ...(typeof value.vertical_datum === 'string' ? { verticalDatum: value.vertical_datum } : {}),
          };
        })();
      const pipe = record(envelope.pipe_networks, 'pipe metadata header');
      this.pipeHeader = {
        ...pipe,
        collections: [], features: [], networks: [], refusals: [],
      };
      return;
    }
    if (kind === 'record') {
      if (this.pending !== null) throw new Error('LandXML stream interleaved a metadata record fragment');
      await this.pushRecord(envelope.record, envelope.value);
      return;
    }
    if (kind === 'record_fragment') {
      await this.pushFragment(envelope);
      return;
    }
    if (kind !== 'end' || this.completed || this.pending !== null || this.skipped !== null || this.pendingPipeRefusals.length !== 0) {
      throw new Error('LandXML stream ended with invalid metadata state');
    }
    this.completed = true;
  }

  finish(): { preflight: LandXmlGeometryPreflight; sourceCoordinateInfo: CoordinateInfo; coordinateSystem: LandXmlTinDocument['coordinateSystem'] } {
    if (!this.completed || !this.headerSeen) throw new Error('LandXML preflight cursor ended without a source header');
    const empty = !Number.isFinite(this.sourceBounds.min.x);
    const bounds = empty
      ? { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }
      : this.sourceBounds;
    const maxAbs = Math.max(
      Math.abs(bounds.min.x), Math.abs(bounds.min.y), Math.abs(bounds.min.z),
      Math.abs(bounds.max.x), Math.abs(bounds.max.y), Math.abs(bounds.max.z),
    );
    const hasLargeCoordinates = maxAbs > 10_000;
    const sourceCoordinateInfo = createCoordinateInfo(
      bounds,
      hasLargeCoordinates ? {
        x: (bounds.min.x + bounds.max.x) / 2,
        y: (bounds.min.y + bounds.max.y) / 2,
        z: (bounds.min.z + bounds.max.z) / 2,
      } : { x: 0, y: 0, z: 0 },
      hasLargeCoordinates,
    );
    return {
      preflight: {
        componentCount: this.componentCount,
        frame: this.dominant === null ? null : deriveLandXmlRenderFrameFromMeasurement(this.measurementBounds, this.dominant.bounds),
      },
      sourceCoordinateInfo,
      coordinateSystem: this.coordinateSystem,
    };
  }

  private addSourcePoint(northing: number, easting: number, elevation: number | undefined): void {
    const units = this.units;
    if (units === null || elevation === undefined) return;
    const point = { x: easting * units.linearScaleToMeters, y: elevation * units.elevationScaleToMeters, z: -northing * units.linearScaleToMeters };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return;
    mergeBounds(this.sourceBounds, { min: point, max: point });
  }

  private async measure(
    bounds: Bounds3D,
    triangles: number,
    mesh: MeshData,
    frameGroup?: number,
  ): Promise<void> {
    this.componentCount++;
    mergeBounds(this.measurementBounds, bounds);
    if (this.dominant === null || triangles > this.dominant.triangles) this.dominant = { bounds, triangles };
    await this.componentSink?.({ mesh, ...(frameGroup === undefined ? {} : { frameGroup }) });
  }

  private async pushRecord(recordName: unknown, value: unknown): Promise<void> {
    if (typeof recordName !== 'string' || this.pipeHeader === null) throw new Error('LandXML stream emitted a record before metadata header');
    this.measureSourceRecord(recordName, value);
    if (recordName === 'pipe_preflight_refusal') {
      this.pendingPipeRefusals.push(value);
      return;
    }
    if (recordName === 'pipe_network') await this.measurePipeNetwork(value);
  }

  /** Fold coordinate-bearing semantic records without retaining their model. */
  private measureSourceRecord(recordName: string, value: unknown): void {
    const planPoint = (candidate: unknown): void => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return;
      const point = candidate as { northing?: unknown; easting?: unknown; elevation?: unknown };
      if (typeof point.northing !== 'number' || typeof point.easting !== 'number') return;
      this.addSourcePoint(point.northing, point.easting, typeof point.elevation === 'number' ? point.elevation : 0);
    };
    const location = (candidate: unknown): void => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return;
      const value = candidate as { kind?: unknown; point?: unknown };
      if (value.kind === 'coordinates') planPoint(value.point);
    };
    if (recordName === 'plan_cogo_point' || recordName === 'plan_resolved_monument') {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) planPoint((value as { point?: unknown }).point);
      return;
    }
    if (recordName === 'plan_resolved_geometry') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
      const geometry = value as Record<string, unknown>;
      for (const field of ['start', 'end', 'center', 'pi']) planPoint(geometry[field]);
      return;
    }
    if (recordName !== 'horizontal_alignment' || typeof value !== 'object' || value === null || Array.isArray(value)) return;
    const segments = (value as { segments?: unknown }).segments;
    if (!Array.isArray(segments)) return;
    for (const segment of segments) {
      if (typeof segment !== 'object' || segment === null || Array.isArray(segment)) continue;
      const primitive = (segment as { primitive?: unknown }).primitive;
      if (typeof primitive !== 'object' || primitive === null || Array.isArray(primitive)) continue;
      const shape = primitive as Record<string, unknown>;
      for (const field of ['start', 'end', 'center', 'pi']) location(shape[field]);
      if (Array.isArray(shape.points)) for (const point of shape.points) planPoint(point);
    }
  }

  private async pushFragment(envelope: Record<string, unknown>): Promise<void> {
    const recordName = envelope.record;
    const sequence = envelope.sequence;
    if (typeof recordName !== 'string' || !Number.isInteger(sequence) || (sequence as number) < 0) {
      throw new Error('LandXML stream emitted an invalid metadata fragment envelope');
    }
    if (recordName !== 'pipe_network' && recordName !== 'pipe_preflight_refusal') {
      if (this.pending !== null) throw new Error('LandXML stream interleaved a discarded metadata fragment');
      if (this.skipped === null) {
        if (sequence !== 0) throw new Error('LandXML metadata fragment started at a nonzero sequence');
        this.skipped = { record: recordName, nextSequence: 0 };
      }
      if (this.skipped.record !== recordName || this.skipped.nextSequence !== sequence) {
        throw new Error('LandXML metadata fragment sequence is invalid');
      }
      this.skipped.nextSequence++;
      if (envelope.continued !== true) this.skipped = null;
      return;
    }
    if (this.skipped !== null) throw new Error('LandXML stream interleaved a metadata fragment');
    const chunk = bytePayload(envelope.payload_utf8);
    if (this.pending === null) {
      if (sequence !== 0) throw new Error('LandXML metadata fragment started at a nonzero sequence');
      this.pending = { record: recordName, nextSequence: 0, chunks: [], bytes: 0 };
    }
    const pending = this.pending;
    if (pending.record !== recordName || pending.nextSequence !== sequence) throw new Error('LandXML metadata fragment sequence is invalid');
    pending.bytes += chunk.byteLength;
    if (pending.bytes > MAX_METADATA_RECORD_BYTES) throw new Error('LandXML metadata fragment exceeds the 512 KiB credit limit');
    pending.chunks.push(chunk);
    pending.nextSequence++;
    if (envelope.continued === true) return;
    const joined = new Uint8Array(pending.bytes);
    let offset = 0;
    for (const part of pending.chunks) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    this.pending = null;
    try {
      await this.pushRecord(recordName, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as unknown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`LandXML stream emitted malformed metadata fragment JSON: ${message}`);
    }
  }

  private async measurePipeNetwork(network: unknown): Promise<void> {
    const header = this.pipeHeader;
    if (header === null) throw new Error('LandXML pipe network arrived before its metadata header');
    const remainingPipeMeshes = MAX_LANDXML_PIPE_MESHES - this.emittedPipeMeshes;
    const pipe = pipeNetworks({ ...header, networks: [network], refusals: this.pendingPipeRefusals });
    // Refusal probes belong to exactly one following network and never become
    // part of the assembled semantic document. Drop them before awaiting mesh
    // delivery so this reducer retains neither a global refusal map nor a
    // completed pipe document.
    this.pendingPipeRefusals.length = 0;
    const cursor = new LandXmlPipeComponentCursor(pipe, this.componentCount + 1, remainingPipeMeshes);
    for (let component = cursor.next(); component !== null; component = cursor.next()) {
      this.emittedPipeMeshes++;
      for (const fragment of fragmentLandXmlGeometryComponent({
        ...component, surfaceName: component.name, surfaceSourceId: null, pipeSourceId: component.sourceId, renderedFaceSourceIds: [],
      })) await this.measure(fragment.bounds, fragment.mesh.indices.length / 3, fragment.mesh);
    }
  }
}
