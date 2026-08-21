/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared postMessage protocol types for ifc-lite embed viewer and SDK.
 *
 * Both the embed viewer (inside the iframe) and the embed SDK (in the host page)
 * import from this package to ensure type safety across the postMessage boundary.
 */

// ============================================================================
// Protocol Constants
// ============================================================================

/** Message discriminator to ignore unrelated postMessage traffic */
export const EMBED_SOURCE = 'ifc-lite-embed' as const;

/** Current protocol version */
export const PROTOCOL_VERSION = '1.0' as const;

// ============================================================================
// Message Envelope
// ============================================================================

/** Base envelope for all messages crossing the iframe boundary */
export interface EmbedMessageEnvelope {
  /** Always 'ifc-lite-embed' - used to filter out unrelated messages */
  source: typeof EMBED_SOURCE;
  /** Protocol version for forward compatibility */
  version: typeof PROTOCOL_VERSION;
  /** Command or event name */
  type: string;
  /** Present on requests, echoed in responses for correlation */
  requestId?: string;
  /** Present on responses, matches the original requestId */
  responseId?: string;
  /** Payload data */
  data?: unknown;
  /** Present on error responses */
  error?: EmbedError;
}

export interface EmbedError {
  code: string;
  message: string;
}

// ============================================================================
// Inbound Commands (parent -> embed viewer)
// ============================================================================

/** All command types the host can send to the embedded viewer */
export type InboundCommandType =
  | 'INIT'
  | 'LOAD_MODEL'
  | 'LOAD_MODEL_BUFFER'
  | 'ADD_MODEL'
  | 'REMOVE_MODEL'
  | 'SELECT'
  | 'SELECT_BY_GUID'
  | 'CLEAR_SELECTION'
  | 'ISOLATE'
  | 'HIDE'
  | 'SHOW'
  | 'SHOW_ALL'
  | 'SET_COLORS'
  | 'RESET_COLORS'
  | 'FIT_TO_VIEW'
  | 'SET_CAMERA'
  | 'SET_VIEW'
  | 'SET_SECTION'
  | 'SET_THEME'
  | 'SET_TYPE_VISIBILITY'
  | 'GET_PROPERTIES'
  | 'GET_SCREENSHOT'
  | 'GET_MODEL_INFO';

/** Payload types for each inbound command */
export interface InboundPayloads {
  INIT: { token?: string; config?: EmbedConfig };
  LOAD_MODEL: { url: string };
  LOAD_MODEL_BUFFER: ArrayBuffer;
  ADD_MODEL: { url: string; name?: string };
  REMOVE_MODEL: { modelId: string };
  SELECT: { ids: number[] };
  SELECT_BY_GUID: { guids: string[] };
  CLEAR_SELECTION: void;
  ISOLATE: { ids: number[] };
  HIDE: { ids: number[] };
  SHOW: { ids: number[] };
  SHOW_ALL: void;
  SET_COLORS: { colorMap: Record<string, [number, number, number, number]> };
  RESET_COLORS: void;
  FIT_TO_VIEW: { ids?: number[] };
  /**
   * Absolute camera orientation in degrees: `azimuth` horizontal (normalized
   * into 0-360), `elevation` from the horizon (clamped just inside ±90°, where
   * the view matrix degenerates). The target and the orbit distance are kept —
   * this rotates the camera, it does not reframe; use `FIT_TO_VIEW` for that.
   *
   * `zoom` is NOT applied. It has no defined meaning on this side (factor?
   * distance? relative to what?), and the viewer deliberately ignores it rather
   * than guessing — see #2934. Treat it as reserved.
   */
  SET_CAMERA: { azimuth: number; elevation: number; zoom?: number };
  SET_VIEW: { preset: ViewPreset };
  SET_SECTION: { axis?: SectionAxis; position?: number; enabled?: boolean; flipped?: boolean };
  SET_THEME: { theme: 'light' | 'dark'; bg?: string };
  SET_TYPE_VISIBILITY: { spaces?: boolean; openings?: boolean; site?: boolean };
  GET_PROPERTIES: { id: number };
  GET_SCREENSHOT: { width?: number; height?: number };
  GET_MODEL_INFO: void;
}

/** Response types for commands that return data */
export interface CommandResponses {
  LOAD_MODEL: ModelStats;
  LOAD_MODEL_BUFFER: ModelStats;
  ADD_MODEL: { modelId: string } & ModelStats;
  SELECT_BY_GUID: { resolved: number[] };
  GET_PROPERTIES: EntityProperties;
  GET_SCREENSHOT: { dataUrl: string };
  GET_MODEL_INFO: ModelInfo;
}

// ============================================================================
// Outbound Events (embed viewer -> parent)
// ============================================================================

/** All event types the embedded viewer can emit to the host */
export type OutboundEventType =
  | 'READY'
  | 'INIT_ACK'
  | 'MODEL_LOADING'
  | 'MODEL_LOADED'
  | 'MODEL_ERROR'
  | 'ENTITY_SELECTED'
  | 'ENTITY_DESELECTED'
  | 'ENTITY_HOVERED'
  | 'CAMERA_CHANGED'
  | 'SECTION_CHANGED';

/** Payload types for each outbound event */
export interface OutboundPayloads {
  READY: { version: string };
  INIT_ACK: void;
  MODEL_LOADING: { progress: number; phase: string };
  MODEL_LOADED: { modelId?: string } & ModelStats;
  MODEL_ERROR: { error: EmbedError };
  ENTITY_SELECTED: { id: number; globalId?: string; modelId?: string; ifcType?: string };
  ENTITY_DESELECTED: void;
  ENTITY_HOVERED: { id: number; globalId?: string; ifcType?: string };
  CAMERA_CHANGED: { azimuth: number; elevation: number; zoom?: number };
  SECTION_CHANGED: { axis: SectionAxis; position: number; enabled: boolean };
}

// ============================================================================
// Shared Data Types
// ============================================================================

export type ViewPreset = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

export type SectionAxis = 'down' | 'front' | 'side';

export interface EmbedConfig {
  theme?: 'light' | 'dark';
  bg?: string;
  controls?: 'orbit' | 'pan' | 'all' | 'none';
  hideAxis?: boolean;
  hideScale?: boolean;
  hideTypes?: string[];
}

export interface ModelStats {
  entities: number;
  triangles: number;
  vertices: number;
}

export interface EntityProperties {
  expressId: number;
  ifcType?: string;
  name?: string;
  globalId?: string;
  attributes: Record<string, unknown>;
  propertySets: PropertySet[];
  quantitySets: QuantitySet[];
}

export interface PropertySet {
  name: string;
  properties: Record<string, unknown>;
}

export interface QuantitySet {
  name: string;
  quantities: Record<string, number>;
}

export interface ModelInfo {
  models: Array<{
    modelId: string;
    name: string;
    entityCount: number;
    triangleCount: number;
    visible: boolean;
  }>;
  totalEntities: number;
  totalTriangles: number;
}

// ============================================================================
// URL Parameter Types
// ============================================================================

/** Parameters that can be passed via URL to the embed viewer */
export interface EmbedUrlParams {
  modelUrl?: string;
  theme?: 'light' | 'dark';
  bg?: string;
  controls?: 'orbit' | 'pan' | 'all' | 'none';
  autoLoad?: boolean;
  hideAxis?: boolean;
  hideScale?: boolean;
  select?: number[];
  isolate?: number[];
  hideTypes?: string[];
  camera?: { azimuth: number; elevation: number; zoom?: number };
  view?: ViewPreset;
}

// ============================================================================
// Helper: Type-safe message creation
// ============================================================================

/** Create a properly typed outbound event message */
export function createEvent<T extends OutboundEventType>(
  type: T,
  data?: OutboundPayloads[T],
): EmbedMessageEnvelope {
  return {
    source: EMBED_SOURCE,
    version: PROTOCOL_VERSION,
    type,
    data,
  };
}

/** Create a properly typed response message */
export function createResponse(
  responseId: string,
  data?: unknown,
  error?: EmbedError,
): EmbedMessageEnvelope {
  return {
    source: EMBED_SOURCE,
    version: PROTOCOL_VERSION,
    type: 'RESPONSE',
    responseId,
    data,
    error,
  };
}

/** Create a properly typed command message */
export function createCommand<T extends InboundCommandType>(
  type: T,
  data?: InboundPayloads[T],
  requestId?: string,
): EmbedMessageEnvelope {
  return {
    source: EMBED_SOURCE,
    version: PROTOCOL_VERSION,
    type,
    requestId,
    data,
  };
}

/** Type guard: is this message from ifc-lite embed? */
export function isEmbedMessage(data: unknown): data is EmbedMessageEnvelope {
  return (
    data !== null &&
    typeof data === 'object' &&
    'source' in data &&
    (data as EmbedMessageEnvelope).source === EMBED_SOURCE
  );
}
