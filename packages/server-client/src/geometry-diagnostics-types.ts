/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The CSG / opening diagnostics wire shape of the parse response.
 *
 * WHY THIS IS A COPY. `@ifc-lite/geometry` owns the canonical
 * `GeometryDiagnostics` (packages/geometry/src/diagnostics.ts), and re-exporting
 * it would be the obvious way to have one definition. This package deliberately
 * ships with an empty `dependencies` map: it is the thin HTTP client, usable in
 * a browser or a Node service that never loads the geometry stack, and
 * `@ifc-lite/geometry` pulls in `@ifc-lite/wasm` (a cargo/wasm-pack build) plus
 * `@ifc-lite/data`. A type-only import would not stay type-only either -
 * declaration emit writes the cross-package reference into `dist/index.d.ts`,
 * so every consumer would have to have the geometry package installed to
 * typecheck. The copy is the cheaper trade.
 *
 * WHAT KEEPS THE COPY HONEST. `geometry-diagnostics-contract.test.ts` compares
 * this interface with the canonical one field by field at COMPILE TIME, so a
 * field added on either side fails `pnpm typecheck` instead of drifting the way
 * this file drifted through #3691, #3752 and #3766 (issue #3857).
 *
 * Split out of `types.ts` under the module-size ratchet, following the
 * `symbolic-types.ts` precedent (#3199); `types.ts` re-exports it, so the
 * package's public surface is unchanged.
 *
 * Field names are camelCase because the Rust producer's `rename_all` says so -
 * unlike the snake_case response envelope this type sits inside.
 */

/**
 * CSG / opening diagnostics for a geometry pass. Mirrors the Rust
 * `GeometryDiagnostics` (camelCase serde) the server and the WASM batch path both
 * emit. `totalCsgFailures` and the classification counts are exact;
 * `productsWithFailures`, `hostsWithOpenings` and `silentNoOps` are batch-summed
 * upper bounds.
 */
export interface GeometryDiagnostics {
  /**
   * Contract version handshake (mirrors Rust
   * `GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION`). Bumped on field renames/removals or
   * count-semantics changes; additive optional fields do not bump. `0`/absent
   * means a pre-versioned producer.
   */
  schemaVersion: number;
  /** Total CSG boolean failures (un-cut openings, emptied hosts, kernel fallbacks). */
  totalCsgFailures: number;
  /** Distinct products with at least one failure (batch-summed upper bound). */
  productsWithFailures: number;
  /** Hosts that had openings processed (batch-summed upper bound). */
  hostsWithOpenings: number;
  /** Opening-classifier outcome counts. */
  classification: {
    rectangular: number;
    diagonal: number;
    nonRectangular: number;
    total: number;
  };
  /** Failure counts by stable reason label, sorted desc by count. */
  failuresByReason: Array<{ reason: string; count: number }>;
  /**
   * Hosts where rectangular cutters ran, the triangle count was unchanged, and NO
   * failure was recorded (cut attempted, geometry not modified). Batch-summed
   * upper bound.
   */
  silentNoOps: number;
  /** rect_fast fast-path engagement (perf observability). */
  rectFast: {
    fired: number;
    openingsCut: number;
    deferHostNotBox: number;
    deferNotThrough: number;
    deferOffFace: number;
    deferNearEdge: number;
    deferNoOpenings: number;
    /** Optional: absent on payloads produced before this counter existed (#1649). */
    deferTooManyOpenings?: number;
  };
  /**
   * Content-hash references the geometry pass refused because they exceeded
   * `u32::MAX` (#3421 / #3752). Nonzero means some instancing was skipped, not
   * that geometry is wrong. Optional: absent on payloads from producers
   * predating the counter.
   */
  oversizedRefDrops?: number;
  /** Bounded top-N worst-failing hosts (opt-in per-product detail). */
  worstHosts: Array<{
    productId: number;
    ifcType: string;
    openings: number;
    csgFailures: number;
    firstFailureLabel?: string;
    /** World-space AABB of the host mesh, when a void cut captured it.
     *  Mirrors the `{min, max}` shape used by `MeshData.localBounds`. */
    bbox?: { min: [number, number, number]; max: [number, number, number] };
    /** Final triangle count of the host's mesh (post-cut when a void
     *  subtraction ran, otherwise the pre-cut count). */
    triangleCount?: number;
  }>;
  /**
   * Representation items dropped from the mesh output because no processor is
   * registered for the item's type, or the registered processor errored (#3691).
   * Optional: absent on payloads from producers predating the counter.
   *
   * AHEAD OF THE CANONICAL TYPE. #3691 is still open at the time of writing, so
   * `@ifc-lite/geometry` does not carry these two fields yet. They are declared
   * here so that PR and this one do not collide over the server wire shape; the
   * contract test allowlists exactly these two names and fails once the
   * canonical type gains them, at which point the allowlist entry is deleted.
   */
  totalUnsupportedItems?: number;
  /** `totalUnsupportedItems` broken down by IFC type, sorted desc by count. */
  unsupportedItemsByType?: Array<{ reason: string; count: number }>;
}
