/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The messages between the site-context client and its worker. */

import type { Attribution } from '@ifc-lite/geodata-ch';
import type { SiteContextIssue, SiteContextLayerKind, SiteContextProgress } from '@ifc-lite/site-context';

export interface SiteContextBuildRequest {
  /** EPSG:2056, easting first. */
  centre: { x: number; y: number };
  radius: number;
  categories: SiteContextLayerKind[];
  /** A parcel EGRID to take instead of the parcel at the centre. */
  egrid?: string;
  /**
   * The model's own building, so the buildings layer can mark it: its EGID when
   * the model states one, else its footprint (EPSG:2056 rings, outer first).
   */
  subject?: { egid?: string; footprint?: Array<Array<{ x: number; y: number }>> };
}

export type SiteContextWorkerRequest = { type: 'build'; id: number; request: SiteContextBuildRequest };

/** One finished category, as a single-category site-context GLB. */
export interface SiteContextCategoryMessage {
  type: 'category';
  id: number;
  kind: SiteContextLayerKind;
  bytes: Uint8Array;
  hasGeometry: boolean;
  complete: boolean;
  issues: SiteContextIssue[];
  attribution: Attribution[];
}

export interface SiteContextWorkerStats {
  requests: number;
  bytes: number;
  cacheHits: number;
}

export type SiteContextWorkerResponse =
  | { type: 'progress'; id: number; progress: SiteContextProgress }
  | SiteContextCategoryMessage
  | { type: 'complete'; id: number; stats: SiteContextWorkerStats }
  | { type: 'error'; id: number; message: string; coverage: boolean; stats: SiteContextWorkerStats };

/**
 * The 3D Tiles read budget for a site of `radius` metres: the reader's preset
 * (64 requests, 32 MiB) is measured for about a 300 m site, and the tiles a
 * site needs grow with its area, so the budget scales with it. At 500 m the
 * preset stopped four tiles short (`buildings-read-truncated`). Bytes stay
 * capped at 128 MiB.
 */
export function buildingsReadBudget(radius: number): { maxRequests: number; maxBytes: number } {
  const area = Math.max(1, (radius / 300) ** 2);
  return { maxRequests: Math.ceil(64 * area), maxBytes: Math.min(128 * 1024 * 1024, Math.ceil(32 * 1024 * 1024 * area)) };
}
