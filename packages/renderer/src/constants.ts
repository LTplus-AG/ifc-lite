/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renderer constants - extracted magic numbers for maintainability
 */

// ============================================================================
// Camera Constants
// ============================================================================

export const CAMERA_CONSTANTS = {
  // Inertia system
  /** Inertia damping factor (0-1), higher = more damping */
  DAMPING_FACTOR: 0.92,
  /** Minimum velocity threshold for inertia */
  MIN_VELOCITY_THRESHOLD: 0.001,

  // Movement speeds
  /** First-person movement speed */
  FIRST_PERSON_SPEED: 0.1,
  /** Orbit sensitivity (radians per pixel) */
  ORBIT_SENSITIVITY: 0.01,
  /** Pan speed multiplier */
  PAN_SPEED_MULTIPLIER: 0.001,
  /** Zoom sensitivity */
  ZOOM_SENSITIVITY: 0.001,
  /** Maximum zoom delta per frame */
  MAX_ZOOM_DELTA: 0.1,
  /** Minimum perspective camera distance from target */
  MIN_PERSPECTIVE_DISTANCE: 0.00001,

  // Default camera setup
  DEFAULT_POSITION: { x: 50, y: 50, z: 100 } as const,
  DEFAULT_TARGET: { x: 0, y: 0, z: 0 } as const,
  DEFAULT_UP: { x: 0, y: 1, z: 0 } as const,
  DEFAULT_FOV: Math.PI / 4, // 45 degrees
  DEFAULT_NEAR: 0.1,
  DEFAULT_FAR: 100000,

  // Depth precision
  /** Maximum near/far ratio for depth precision */
  MAX_NEAR_FAR_RATIO: 10000,
  /** Near plane as percentage of distance */
  NEAR_DISTANCE_FACTOR: 0.001,
  /** Far plane multiplier of distance */
  FAR_DISTANCE_MULTIPLIER: 10,

  // Gimbal lock prevention
  /** Minimum phi angle to prevent gimbal lock at poles */
  MIN_PHI: 0.15,
  /** Maximum phi angle to prevent gimbal lock at poles */
  MAX_PHI: Math.PI - 0.15,
  /** Sin phi threshold for pole detection */
  POLE_THRESHOLD: 0.05,

  // Animation
  /** Default animation duration in ms */
  DEFAULT_ANIMATION_DURATION: 500,
  /** Quick animation duration in ms */
  QUICK_ANIMATION_DURATION: 300,

  // Fit to bounds
  /** Distance multiplier for fitToBounds */
  FIT_DISTANCE_MULTIPLIER: 2.0,
  /** Padding multiplier for frame selection */
  FRAME_PADDING_MULTIPLIER: 1.2,
  /** Padding multiplier for zoom extent */
  ZOOM_EXTENT_PADDING: 1.5,

  // Isometric view offsets
  ISOMETRIC_OFFSET: { right: 0.6, up: 0.5, front: 0.6 } as const,
} as const;

// ============================================================================
// BVH Constants
// ============================================================================

export const BVH_CONSTANTS = {
  /** Minimum mesh count to trigger BVH construction */
  THRESHOLD: 100,
  /** Maximum primitives per leaf node */
  MAX_PRIMITIVES_PER_LEAF: 4,
  /** Maximum tree depth */
  MAX_DEPTH: 32,
} as const;

// ============================================================================
// Error Handling Constants
// ============================================================================

export const ERROR_CONSTANTS = {
  /** Rate limit for render error logging (ms) */
  RENDER_ERROR_THROTTLE_MS: 1000,
} as const;

// ============================================================================
// Pipeline Constants
// ============================================================================

export const PIPELINE_CONSTANTS = {
  // Buffer layout (bytes) - must match WGSL shader expectations
  /** Total uniform buffer size */
  UNIFORM_BUFFER_SIZE: 192,
  /** Byte offset for flags in uniform buffer */
  FLAGS_BYTE_OFFSET: 176,

  // MSAA
  /** Default MSAA sample count */
  DEFAULT_SAMPLE_COUNT: 4,

  // Depth buffer
  /**
   * Depth/stencil format used by RenderPipeline. Switched from depth32float
   * to depth24plus-stencil8 when the 3D section work introduced a render
   * pass shared by the main opaque, the section-plane preview, and the 2D
   * overlay cap — WebGPU requires a single depth-stencil format across all
   * pipelines that write to the same pass attachment.
   */
  DEPTH_FORMAT: 'depth24plus-stencil8' as const,
} as const;

// ============================================================================
// Lighting Constants (for shaders)
// ============================================================================

export const LIGHTING_CONSTANTS = {
  // Directional lights (normalized directions)
  SUN_LIGHT: { x: 0.5, y: 1.0, z: 0.3 } as const,
  FILL_LIGHT: { x: -0.5, y: 0.3, z: -0.3 } as const,
  RIM_LIGHT: { x: 0.0, y: 0.2, z: -1.0 } as const,

  // Hemisphere colors
  SKY_COLOR: { r: 0.3, g: 0.35, b: 0.4 } as const,
  GROUND_COLOR: { r: 0.15, g: 0.1, b: 0.08 } as const,

  // Intensities
  AMBIENT_INTENSITY: 0.25,
  DIFFUSE_SUN_INTENSITY: 0.55,
  DIFFUSE_FILL_INTENSITY: 0.15,
  RIM_INTENSITY: 0.15,
  WRAP_FACTOR: 0.3,
} as const;

// ============================================================================
// Batch Buffer Constants
// ============================================================================

export const BATCH_CONSTANTS = {
  /** Safety factor for GPU buffer size — use 90% of device limit to leave headroom */
  BUFFER_SIZE_SAFETY_FACTOR: 0.9,
  /** Fallback max buffer size when device limit is unavailable (256 MB) */
  FALLBACK_MAX_BUFFER_SIZE: 256 * 1024 * 1024,
  /** Bytes per vertex in the interleaved layout (pos3 + norm3 + entityId1 = 7 × 4) */
  BYTES_PER_VERTEX: 7 * 4,
  /** Bytes per index (uint32) */
  BYTES_PER_INDEX: 4,
} as const;

// ============================================================================
// Pick Constants
// ============================================================================

export const PICK_CONSTANTS = {
  /** Maximum meshes to create for picking during streaming */
  MAX_PICK_MESH_CREATION: 500,
  /** Pick buffer format */
  BUFFER_FORMAT: 'rgba8unorm' as const,
} as const;
