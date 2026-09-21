/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5049 witness fixtures and its serialisable evidence contract. */

import type { DecodedInstancedShard, MeshData } from '@ifc-lite/renderer';

export const COMMON_ORIGIN: [number, number, number] = [5_000_000.015625, 100, -50];
export const LARGE_ORIGIN: [number, number, number] = [5_020_000.015625, 100, -50];
export const PICK_CSS_X = 320;
export const PICK_CSS_Y = 240;
export const GEOMETRIC_TOLERANCE_METRES = 0.03;

type WitnessStatus = 'pending' | 'passed' | 'skipped' | 'failed';

export interface RteGpuWitnessReport {
  status: WitnessStatus;
  reason?: string;
  system: { userAgent: string; platform: string; devicePixelRatio: number; adapter: { vendor?: string; architecture?: string } | null };
  tolerance: { geometricMetres: number; pixel: number };
  commonTranslation: readonly [number, number, number];
  largeLocalExtentMetres: number;
  evidence?: {
    canvasPixels: { width: number; height: number };
    pickPixel: { x: number; y: number };
    pick: { expressId: number; worldXYZ?: [number, number, number] } | null;
    texturedPick: number | null;
    instancedPick: number | null;
    pointPick: number | null;
    linePixel: [number, number, number, number] | null;
    colorPixel: [number, number, number, number] | null;
    cpuRay: { expressId: number; point: [number, number, number] } | null;
    sourceResidualMetres: number;
    pickResidualMetres: number | null;
    CPUAndGpuAgree: boolean;
    snapResidualMetres: number | null;
    measurementResidualMetres: number | null;
    provenanceStable: boolean;
    families: Record<string, boolean>;
    quantized: boolean;
    instancedDrawn: number;
    pointAssets: number;
    clippedPick: boolean;
    sectionPick: boolean;
    shadowDrawCalls: number;
    highlightDrawCalls: number;
    screenshotBytes: number;
    diagnostics: { gpuErrors: number; errors: number; lastGpuError: string; lastError: string };
  };
}

export function witnessMesh(expressId: number, origin: [number, number, number], color: [number, number, number, number], textured = false): MeshData {
  const result: MeshData = {
    expressId,
    positions: new Float32Array([-10, -8, 0, 10, -8, 0, 0, 10, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), color, origin,
  };
  if (textured) {
    result.uvs = new Float32Array([0, 0, 1, 0, 0.5, 1]);
    result.texture = { width: 2, height: 2, rgba: new Uint8Array([
      32, 255, 64, 255, 255, 255, 32, 255, 32, 64, 255, 255, 255, 32, 255, 255,
    ]), repeatS: false, repeatT: false };
  }
  return result;
}

export function largeExtentMesh(): MeshData {
  const span = 8_192;
  return {
    expressId: 104,
    positions: new Float32Array([-span / 2, -span / 2, 0, span / 2, -span / 2, 0, 0, span / 2, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    color: [0.3, 0.6, 1, 1], origin: LARGE_ORIGIN,
  };
}

export function instancedShard(): DecodedInstancedShard {
  // Native IFC Z-up origin maps to the same Y-up common translation as flat meshes.
  return {
    templates: [{
      positions: new Float32Array([-3, -3, 0, 3, -3, 0, 0, 3, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
      origin: [COMMON_ORIGIN[0] + 24, -COMMON_ORIGIN[2], COMMON_ORIGIN[1]],
    }],
    instances: [{
      templateIndex: 0, entityId: 103, color: [0.1, 0.8, 1, 1],
      transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    }], carriesItemIds: false,
  };
}

export function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function baseReport(): RteGpuWitnessReport {
  return {
    status: 'pending',
    system: { userAgent: navigator.userAgent, platform: navigator.platform, devicePixelRatio: window.devicePixelRatio, adapter: null },
    tolerance: { geometricMetres: GEOMETRIC_TOLERANCE_METRES, pixel: 1 },
    commonTranslation: COMMON_ORIGIN, largeLocalExtentMetres: 8_192,
  };
}
