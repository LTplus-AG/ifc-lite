/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StreamingGeometryEvent } from '@ifc-lite/geometry';

export const fixtures = {
  house: { path: 'ara3d/AC20-FZK-Haus.ifc', bytes: 2526544,
    sha256: 'ea6f04eaf92fac4d7ad0038bc3d2dfea4c094dd3f516ecc33c50bf1835ca108d', timeoutMs: 180000 },
  csg: { path: 'ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc', bytes: 12030684,
    sha256: 'ffdfa9a91ac6a6c301d7da0d7861dfbc3958ceb55098c143a560468702642131', timeoutMs: 300000 },
  'heavy-csg': { path: 'ara3d/ISSUE_053_20181220Holter_Tower_10.ifc', bytes: 177465622,
    sha256: 'd8cc92c00ba634d9f25f3d00185136cbc34f3b14f2cc552634551997ddc148f8', timeoutMs: 600000 },
  architecture: { path: 'various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc', bytes: 342657851,
    sha256: 'e91ddbbd672bbde946af14631de4c732f0cf8a7cfae5dbbf06fbeab03b5c46df', timeoutMs: 600000 },
} as const;
export type Family = keyof typeof fixtures;
export type Complete = Extract<StreamingGeometryEvent, { type: 'complete' }>;
export const bounds = { events: 250000, buffers: 500000, retainedBytes: 2 * 1024 ** 3,
  objectVisits: 8000000, identities: 1000000, hashChunkBytes: 4 * 1024 ** 2,
  hashMs: 120000, cleanupMs: 30000, ownRssBytes: 5 * 1024 ** 3 } as const;
export interface Receipt {
  status: 'running' | 'geometry-drained' | 'supported-output' | 'refused';
  family: Family;
  events: number;
  eventCounts: Record<string, number>;
  retainedBytes: number;
  bufferCount: number;
  collectMs: number;
  elapsedMs?: number;
  hashMs?: number;
  error?: string;
  cleanupError?: string;
  generatorDone: boolean;
  processorDisposed: boolean;
  workerMemory: Extract<StreamingGeometryEvent, { type: 'workerMemory' }>[];
  complete?: Complete;
  identity?: { sha256: string; flat: number; occurrences: number; triangles: number };
}
export function failure(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
