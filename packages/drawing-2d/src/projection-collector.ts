/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Construction projection lines (issue #979), collected one batch of meshes
 * at a time so a streamed drawing source never has to hold its whole model.
 *
 * Project geometry BEYOND the cut into two architectural bands:
 *   • below the cut → VISIBLE  (thin solid)
 *   • above the cut → OVERHEAD (dashed, carried as `visibility:'hidden'`)
 *
 * Sources, picked per element to avoid double-drawing the same wall:
 *   • extruded-area solids → clean profile boundaries (`projectProfiles`)
 *   • everything else      → mesh SILHOUETTE outline (NOT crease edges,
 *     which draw every tessellation facet). Only with `includeEdges`.
 *
 * Profile lines come first, then each mesh's lines in input order, exactly
 * as the single-array generator produced them.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { DrawingLine, EntityKey, MeshOutline2D, ProfileEntry, SectionAxis, SectionConfig } from './types.js';
import { makeEntityKey } from './types.js';
import type { EdgeExtractor } from './edge-extractor.js';
import { projectProfiles } from './profile-projector.js';
import { type ProjectionBandDepths, getViewDirectionForPlane, outlineToProjectionLines } from './projection-bands.js';
import { isFeatureElementType } from './feature-elements.js';
import { projectionBandMeshes } from './projection-clip.js';
import { removeCoveredOverhead } from './projection-overlap.js';

export interface ProjectionCollectorOptions {
  includeEdges: boolean;
  outlineProvider?: (mesh: MeshData, axis: SectionAxis, flipped: boolean) => MeshOutline2D | null;
}

export class ProjectionCollector {
  private lines: DrawingLine[] = [];
  private readonly coveredKeys = new Set<EntityKey>();
  private readonly bands: ProjectionBandDepths;
  private readonly outlineProvider: ProjectionCollectorOptions['outlineProvider'];

  constructor(
    private readonly config: SectionConfig,
    private readonly options: ProjectionCollectorOptions,
    private readonly edgeExtractor: EdgeExtractor,
    profiles: readonly ProfileEntry[] | undefined,
  ) {
    this.bands = {
      below: config.projectionBelowDepth ?? config.projectionDepth,
      above: config.projectionAboveDepth ?? config.projectionDepth,
    };
    // Feature elements (IfcOpeningElement & the void/feature family) are
    // boolean operands, not building structure — they must never project
    // (issue #979 follow-up). Filter them from BOTH the profile path and the
    // silhouette path: dropping them only from profiles would push them onto
    // the silhouette path (they'd fall out of `coveredKeys` and their raw
    // mesh would then be silhouetted), so the two must be filtered together.
    // The Rust extractor already skips them at the source, but a CI-lagged
    // WASM bundle can still emit opening profiles, and opening MESHES always
    // reach the meshes — so this TS filter is the load-bearing guard.
    const projectionProfiles = (config.clipProjectionBands ? undefined : profiles)?.filter((p) => !isFeatureElementType(p.ifcType));
    // Per-element dedup: elements with an extracted profile take their
    // projection from the clean profile path only; the silhouette skips them.
    if (projectionProfiles && projectionProfiles.length > 0) {
      for (const profile of projectionProfiles) this.coveredKeys.add(makeEntityKey(profile.modelIndex, profile.expressId));
      this.lines.push(...projectProfiles(projectionProfiles, config.plane, this.bands));
    }
    // The outline provider contract is CARDINAL-only: it receives just
    // (axis, flipped) and returns contours in cardinal projection space (the
    // Rust `meshOutline2d` binding knows nothing of custom planes). The depth
    // raster and every other line producer work in the custom basis when
    // `customPlane` is set, so provider output would be band-classified and
    // occlusion-sampled in a DIFFERENT coordinate system (PR #2644 review).
    // Do NOT "optimise" the provider back in on custom planes without making
    // its callback contract (and the WASM binding behind it) basis aware.
    this.outlineProvider = config.plane.customPlane ? undefined : options.outlineProvider;
  }

  /** Outline every eligible mesh of one batch; keeps no reference to it. */
  add(meshes: readonly MeshData[]): void {
    if (!this.options.includeEdges) return;
    const { config, bands, outlineProvider } = this;
    const viewDir = getViewDirectionForPlane(config.plane);
    for (const source of meshes) {
      if (isFeatureElementType(source.ifcType) || this.coveredKeys.has(makeEntityKey(source.modelIndex ?? 0, source.expressId))) continue;
      const clipped = config.clipProjectionBands
        ? projectionBandMeshes(source, config.plane, bands.below, bands.above) : [source];
      for (const mesh of clipped) {
        const outline = outlineProvider ? outlineProvider(mesh, config.plane.axis, config.plane.flipped) : null;
        if (outline && outline.contours.length > 0) {
          this.lines.push(...outlineToProjectionLines(outline,
            { entityId: mesh.expressId, ifcType: mesh.ifcType ?? 'Unknown', modelIndex: mesh.modelIndex ?? 0 },
            config.plane, bands));
        } else {
          const edges = this.edgeExtractor.extractEdges(mesh);
          const silhouettes = this.edgeExtractor.extractSilhouettes(edges, viewDir);
          this.lines.push(...this.edgeExtractor.edgesToProjectionLines(silhouettes, config.plane, bands));
        }
      }
    }
  }

  /** The collected lines. Projection edges are bounded by depth and visibility, not the cut extent. */
  finish(): DrawingLine[] {
    const { config } = this;
    return config.clipProjectionBands && config.plane.axis === 'y' && !config.plane.customPlane
      ? removeCoveredOverhead(this.lines) : this.lines;
  }
}
