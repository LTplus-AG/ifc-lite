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
  /**
   * Sent for BOTH user navigation (orbit/pan drag, keyboard, ViewCube) and a
   * programmatic SET_CAMERA. Cadence: at most one event per 100ms while the
   * camera keeps moving, plus one trailing event carrying the pose it settled
   * on -- never one per animation frame. A pose identical to the last one
   * reported is not re-sent.
   */
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

/**
 * Parameters that can be passed via URL to the embed viewer.
 *
 * Every field here is parsed by the viewer. Three are parsed and NOT yet
 * applied, and they are marked as such below rather than left to look
 * implemented: presence in this type is not a behaviour guarantee, and
 * pretending otherwise is what #2934 was about.
 */
export interface EmbedUrlParams {
  /** Model to fetch on load. http(s) only; other schemes are rejected. */
  modelUrl?: string;
  theme?: 'light' | 'dark';
  /** Background colour, hex digits without the leading `#`. */
  bg?: string;
  /**
   * NOT YET IMPLEMENTED — parsed and ignored. There is no interaction gate in
   * the camera controller to restrict orbit/pan/zoom against; wheel and pinch
   * zoom in particular bypass the orbit/pan entry points entirely. Tracked
   * separately from #2934 so it is not mistaken for wiring work.
   */
  controls?: 'orbit' | 'pan' | 'all' | 'none';
  /** `false` suppresses the automatic fetch of `modelUrl`. Default: load. */
  autoLoad?: boolean;
  /** NOT YET IMPLEMENTED — parsed and ignored; the axis triad renders regardless. */
  hideAxis?: boolean;
  /** NOT YET IMPLEMENTED — parsed and ignored; the scale bar renders regardless. */
  hideScale?: boolean;
  /** Entity ids to select once the first model is on screen. */
  select?: number[];
  /** Entity ids to isolate once the first model is on screen. */
  isolate?: number[];
  /**
   * IFC class names to hide, e.g. `IfcSpace`. Arbitrary class names are
   * accepted and matched case-insensitively, so `IFCSPACE`, `ifcspace` and
   * `IfcSpace` all name the same class.
   */
  hideTypes?: string[];
  /**
   * Initial absolute camera orientation in degrees; the model is framed at
   * that orientation. `zoom` is accepted for backwards compatibility and is
   * NOT applied — the viewer has no absolute-zoom actuator and the field
   * carries no unit, so framing comes from a fit instead.
   */
  camera?: { azimuth: number; elevation: number; zoom?: number };
  /** Preset view direction. Takes precedence over `camera`. */
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
