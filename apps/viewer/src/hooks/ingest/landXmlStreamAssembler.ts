/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Source-document ownership after strict, bounded stream reassembly. */

import { LandXmlSurfaceFragmentAssembler } from './landXmlSurfaceFragmentAssembler.js';
import { bytes, MAX_LANDXML_ASSEMBLED_COMPONENT_BYTES, object, payload, type LandXmlAssembledSurface, type LandXmlSurfaceStreamComponent } from './landXmlStreamWire.js';
export { LandXmlSurfaceFragmentAssembler } from './landXmlSurfaceFragmentAssembler.js';
export {
  MAX_LANDXML_ASSEMBLED_COMPONENT_BYTES,
  type LandXmlAssembledSurface,
  type LandXmlSurfaceStreamComponent,
  type LandXmlSurfaceStreamFragment,
} from './landXmlStreamWire.js';

interface PendingMetadataPayload {
  record: string;
  nextSequence: number;
  chunks: Uint8Array[];
  bytes: number;
}


function values(target: Record<string, unknown>, field: string): unknown[] {
  const value = target[field];
  if (!Array.isArray(value)) throw new Error(`LandXML metadata header has an invalid ${field} collection`);
  return value;
}

/**
 * The Rust cursor deliberately keeps presentation-derived plan fields out of
 * its metadata header. They arrive as separately credited record events. The
 * normal (non-streaming) WASM document has these arrays, so initialise the
 * compatibility document here rather than requiring an invented header wire
 * shape from Rust.
 */
function initialiseDerivedPlanCollections(plan: Record<string, unknown>): void {
  for (const field of [
    'source_batches', 'parcel_probes', 'resolved_monuments', 'resolved_geometry',
  ]) {
    if (field in plan) {
      values(plan, field);
    } else {
      plan[field] = [];
    }
  }
}

function text(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`LandXML stream emitted an invalid ${context}`);
  return value;
}

/** Complete raw source shape accepted by `readLandXmlSourceDocument`. */
export interface LandXmlAssembledSourceDocument {
  tin: Record<string, unknown>;
  alignments: Record<string, unknown>;
  alignment_render_spans: unknown;
  alignment_render_refusals: unknown;
  alignment_render_truncated: unknown;
}

/**
 * Reassembles the renderer-independent stream wire without reparsing source
 * bytes. Surfaces are yielded immediately; their references are moved once
 * into the semantic document when the metadata header arrives.
 */
export class LandXmlStreamDocumentAssembler {
  private readonly surface = new LandXmlSurfaceFragmentAssembler();
  private readonly surfaces: LandXmlAssembledSurface[] = [];
  private terrain: Record<string, unknown> | null = null;
  private plan: Record<string, unknown> | null = null;
  private alignments: Record<string, unknown> | null = null;
  private pipeNetworks: Record<string, unknown> | null = null;
  private readonly alignmentRenderSpans: unknown[] = [];
  private readonly alignmentRenderRefusals: unknown[] = [];
  private alignmentRenderTruncated = false;
  private metadataPayload: PendingMetadataPayload | null = null;
  private completed = false;

  get pendingSurfaceBytes(): number { return this.surface.pendingBytes; }

  push(event: unknown): { surface: LandXmlAssembledSurface | null; document: LandXmlAssembledSourceDocument | null } {
    const envelope = object(event, 'stream event');
    const kind = text(envelope.kind, 'stream event kind');
    if (kind === 'header') return { surface: null, document: null };
    if (kind === 'surface') {
      if (this.completed) throw new Error('LandXML stream emitted a surface after metadata End');
      const complete = this.surface.push({
        source_id: text(envelope.source_id, 'surface source id'),
        component: text(envelope.component, 'surface component') as LandXmlSurfaceStreamComponent,
        sequence: typeof envelope.sequence === 'number' ? envelope.sequence : Number.NaN,
        continued: envelope.continued === true,
        payload_utf8: envelope.payload_utf8,
      });
      if (complete !== null) {
        this.surfaces.push(complete);
        const terrain = this.terrain;
        if (terrain !== null) values(terrain, 'surfaces').push(complete);
      }
      return { surface: complete, document: null };
    }
    if (kind !== 'metadata') throw new Error('LandXML stream emitted an unknown event kind');
    const metadataKind = text(envelope.metadata_kind, 'metadata event kind');
    if (metadataKind === 'header') {
      if (this.terrain !== null || this.completed) throw new Error('LandXML stream emitted multiple metadata headers');
      this.terrain = { ...object(envelope.terrain, 'terrain metadata header') };
      values(this.terrain, 'surfaces').push(...this.surfaces);
      this.surfaces.length = 0;
      this.plan = { ...object(envelope.plan, 'plan metadata header') };
      initialiseDerivedPlanCollections(this.plan);
      this.alignments = { ...object(envelope.alignments, 'alignment metadata header') };
      this.pipeNetworks = { ...object(envelope.pipe_networks, 'pipe metadata header') };
      return { surface: null, document: null };
    }
    if (metadataKind === 'record') {
      if (this.metadataPayload !== null) throw new Error('LandXML stream interleaved a metadata record fragment');
      this.pushMetadataRecord(text(envelope.record, 'metadata record kind'), envelope.value);
      return { surface: null, document: null };
    }
    if (metadataKind === 'record_fragment') {
      this.pushMetadataFragment(envelope);
      return { surface: null, document: null };
    }
    if (metadataKind !== 'end' || this.completed) throw new Error('LandXML stream emitted an invalid metadata End');
    if (this.surface.hasPendingSurface) throw new Error('LandXML stream ended with an incomplete surface');
    if (this.metadataPayload !== null) throw new Error('LandXML stream ended with an incomplete metadata record fragment');
    const terrain = this.terrain;
    const alignments = this.alignments;
    const plan = this.plan;
    const pipeNetworks = this.pipeNetworks;
    if (terrain === null || plan === null || alignments === null || pipeNetworks === null) throw new Error('LandXML stream ended before its metadata header');
    terrain.pipe_networks = pipeNetworks;
    const document = {
      tin: { ...terrain, plan },
      alignments,
      alignment_render_spans: this.alignmentRenderSpans,
      alignment_render_refusals: this.alignmentRenderRefusals,
      alignment_render_truncated: this.alignmentRenderTruncated,
    };
    this.completed = true;
    return { surface: null, document };
  }

  abort(): void {
    this.surface.abort();
    this.surfaces.length = 0;
    this.terrain = null;
    this.plan = null;
    this.alignments = null;
    this.pipeNetworks = null;
    this.alignmentRenderSpans.length = 0;
    this.alignmentRenderRefusals.length = 0;
    this.alignmentRenderTruncated = false;
    this.metadataPayload = null;
    this.completed = true;
  }

  private pushMetadataFragment(envelope: Record<string, unknown>): void {
    if (this.terrain === null || this.completed) {
      throw new Error('LandXML metadata record fragment arrived outside a cursor session');
    }
    const record = text(envelope.record, 'metadata record fragment kind');
    const sequence = envelope.sequence;
    if (!Number.isInteger(sequence) || (sequence as number) < 0) {
      throw new Error('LandXML stream emitted an invalid metadata record fragment sequence');
    }
    const chunk = bytes(envelope.payload_utf8);
    if (this.metadataPayload === null) {
      if (sequence !== 0) throw new Error('LandXML metadata record fragment started at a nonzero sequence');
      this.metadataPayload = { record, nextSequence: 0, chunks: [], bytes: 0 };
    }
    const pending = this.metadataPayload;
    if (pending.record !== record || pending.nextSequence !== sequence) {
      throw new Error('LandXML metadata record fragment continuation sequence is invalid');
    }
    pending.bytes += chunk.byteLength;
    if (pending.bytes > MAX_LANDXML_ASSEMBLED_COMPONENT_BYTES) {
      throw new Error('LandXML metadata record exceeds its bounded assembly limit');
    }
    pending.chunks.push(chunk);
    pending.nextSequence++;
    if (envelope.continued === true) return;
    const value = payload(pending.chunks, pending.bytes);
    this.metadataPayload = null;
    this.pushMetadataRecord(record, value);
  }

  private pushMetadataRecord(kind: string, value: unknown): void {
    const terrain = this.terrain;
    const plan = this.plan;
    const alignments = this.alignments;
    const pipeNetworks = this.pipeNetworks;
    if (terrain === null || plan === null || alignments === null || pipeNetworks === null || this.completed) {
      throw new Error('LandXML metadata record arrived outside a cursor session');
    }
    const terrainFields: Readonly<Record<string, string>> = {
      terrain_extension: 'extensions', terrain_warning: 'warnings', terrain_alignment: 'alignments',
      terrain_profile: 'profiles', terrain_cross_section: 'cross_sections',
      terrain_cross_section_surface: 'cross_section_surfaces', terrain_roadway: 'roadways',
      terrain_capability_diagnostic: 'capability_diagnostics', terrain_preserved_only_extension: 'preserved_only_extensions',
    };
    const pipeFields: Readonly<Record<string, string>> = {
      pipe_collection: 'collections', pipe_feature: 'features', pipe_network: 'networks', pipe_refusal: 'refusals',
    };
    if (kind in terrainFields) {
      values(terrain, terrainFields[kind]!).push(value);
      return;
    }
    if (kind in pipeFields) {
      values(pipeNetworks, pipeFields[kind]!).push(value);
      return;
    }
    // The Rust cursor sends a refusal probe before the one network it affects
    // so preflight can stay bounded. It is intentionally not a second source
    // refusal: the ordinary source-ordered record arrives later.
    if (kind === 'pipe_preflight_refusal') return;
    const planFields: Readonly<Record<string, string>> = {
      plan_cogo_point: 'cogo_points', plan_monument: 'monuments', plan_feature: 'plan_features',
      plan_parcel: 'parcels', plan_warning: 'warnings', plan_source_batch: 'source_batches',
      plan_parcel_probe: 'parcel_probes', plan_resolved_monument: 'resolved_monuments',
      plan_resolved_geometry: 'resolved_geometry',
    };
    if (kind in planFields) {
      values(plan, planFields[kind]!).push(value);
      return;
    }
    if (kind === 'horizontal_alignment') {
      values(alignments, 'alignments').push(value);
      return;
    }
    if (kind === 'horizontal_alignment_warning') {
      values(alignments, 'warnings').push(value);
      return;
    }
    if (kind === 'alignment_render_span') {
      this.alignmentRenderSpans.push(value);
      return;
    }
    if (kind === 'alignment_render_refusal') {
      this.alignmentRenderRefusals.push(value);
      return;
    }
    if (kind === 'alignment_render_truncated') {
      if (typeof value !== 'boolean') throw new Error('LandXML stream emitted an invalid alignment render truncation flag');
      this.alignmentRenderTruncated = value;
      return;
    }
    throw new Error(`LandXML stream emitted an unknown metadata record ${kind}`);
  }
}
