/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Public CSG / opening diagnostics contract for @ifc-lite/geometry. The shape
 * mirrors the Rust `GeometryDiagnostics` (rust/geometry router::diagnostics),
 * which is built once per geometry batch and serialized to a JS object. The
 * geometry worker merges per-batch values across batches and the parallel loader
 * merges across workers, surfacing one `diagnostics` object on the streaming
 * `complete` event. The native `ProcessingStats` path reuses the same
 * aggregator (wired: `rust/processing` populates `geometry_diagnostics`).
 *
 * Counts are best-effort observability: `totalCsgFailures` and the classification
 * counts are exact, while `productsWithFailures` / `hostsWithOpenings` /
 * `silentNoOps` are summed per batch and are therefore upper bounds (a product
 * whose geometry spans batches may be counted more than once).
 */
export interface GeometryDiagnostics {
  /**
   * Contract version handshake (mirrors Rust
   * `GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION`, currently 1). Bumped on field
   * renames/removals or count-semantics changes; additive optional fields do
   * not bump. `0`/absent means a pre-versioned producer.
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
   * failure was recorded (cut attempted, geometry not modified) - the highest-
   * signal "looks wrong but did not error" indicator. Hosts that failed are
   * excluded (they are loud failures counted in totalCsgFailures, not silent).
   * Batch-summed upper bound.
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
}

/** Cap on the merged worst-hosts detail list (matches the Rust WORST_HOSTS_LIMIT). */
const WORST_HOSTS_LIMIT = 16;

/**
 * Merge two GeometryDiagnostics (per-batch -> per-load, or per-worker ->
 * per-model). Scalars sum; classification + rectFast sum field-wise;
 * failuresByReason merges by reason; worstHosts concatenates, re-ranks by failure
 * count, and is capped. `null` operands pass through so callers can fold a stream.
 */
export function mergeGeometryDiagnostics(
  a: GeometryDiagnostics | null | undefined,
  b: GeometryDiagnostics | null | undefined,
): GeometryDiagnostics | null {
  if (!a) return b ?? null;
  if (!b) return a;

  const schemaVersion = Math.max(a.schemaVersion ?? 0, b.schemaVersion ?? 0);

  const reasons = new Map<string, number>();
  for (const r of a.failuresByReason) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + r.count);
  for (const r of b.failuresByReason) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + r.count);
  const failuresByReason = [...reasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((x, y) => y.count - x.count || x.reason.localeCompare(y.reason));

  // Fold by productId first (a host whose geometry spans batches/workers can
  // appear in both operands' lists) before re-ranking and capping, mirroring the
  // failuresByReason merge-by-key above. Copy each entry so the operands are not
  // mutated.
  const hostById = new Map<number, GeometryDiagnostics['worstHosts'][number]>();
  for (const h of [...a.worstHosts, ...b.worstHosts]) {
    const prev = hostById.get(h.productId);
    if (prev) {
      prev.csgFailures += h.csgFailures;
      prev.openings += h.openings;
      prev.firstFailureLabel = prev.firstFailureLabel ?? h.firstFailureLabel;
      // bbox/triangleCount describe a single physical host's mesh, not a
      // per-batch tally — keep the first captured value rather than summing
      // (matches the firstFailureLabel precedent above).
      prev.bbox = prev.bbox ?? h.bbox;
      prev.triangleCount = prev.triangleCount ?? h.triangleCount;
    } else {
      hostById.set(h.productId, { ...h });
    }
  }
  const worstHosts = [...hostById.values()]
    .sort((x, y) => y.csgFailures - x.csgFailures || x.productId - y.productId)
    .slice(0, WORST_HOSTS_LIMIT);

  return {
    schemaVersion,
    totalCsgFailures: a.totalCsgFailures + b.totalCsgFailures,
    productsWithFailures: a.productsWithFailures + b.productsWithFailures,
    hostsWithOpenings: a.hostsWithOpenings + b.hostsWithOpenings,
    classification: {
      rectangular: a.classification.rectangular + b.classification.rectangular,
      diagonal: a.classification.diagonal + b.classification.diagonal,
      nonRectangular: a.classification.nonRectangular + b.classification.nonRectangular,
      total: a.classification.total + b.classification.total,
    },
    failuresByReason,
    silentNoOps: a.silentNoOps + b.silentNoOps,
    rectFast: {
      fired: a.rectFast.fired + b.rectFast.fired,
      openingsCut: a.rectFast.openingsCut + b.rectFast.openingsCut,
      deferHostNotBox: a.rectFast.deferHostNotBox + b.rectFast.deferHostNotBox,
      deferNotThrough: a.rectFast.deferNotThrough + b.rectFast.deferNotThrough,
      deferOffFace: a.rectFast.deferOffFace + b.rectFast.deferOffFace,
      deferNearEdge: a.rectFast.deferNearEdge + b.rectFast.deferNearEdge,
      deferNoOpenings: a.rectFast.deferNoOpenings + b.rectFast.deferNoOpenings,
      deferTooManyOpenings: (a.rectFast.deferTooManyOpenings ?? 0) + (b.rectFast.deferTooManyOpenings ?? 0),
    },
    worstHosts,
  };
}
