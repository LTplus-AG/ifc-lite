/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Human-readable renderer for the `GeometryDiagnostics` contract, shared by
 * `diagnose-geometry` and `export --diagnostics` so both surfaces print the
 * identical report.
 */
import type { GeometryDiagnostics } from '@ifc-lite/geometry';

/** One-liner used when the geometry pass recorded nothing diagnostic-worthy. */
export const NO_DIAGNOSTICS_LINE =
  'No CSG / opening diagnostics recorded (no openings cut, no failures).';

export function formatGeometryReport(d: GeometryDiagnostics): string {
  const lines: string[] = [];
  lines.push('Geometry diagnostics');
  lines.push('====================');
  lines.push(
    `CSG failures:        ${d.totalCsgFailures} across ${d.productsWithFailures} product(s)`,
  );
  lines.push(`Hosts with openings: ${d.hostsWithOpenings}`);
  lines.push(
    `Openings classified: ${d.classification.total} ` +
      `(rectangular ${d.classification.rectangular}, diagonal ${d.classification.diagonal}, ` +
      `non-rectangular ${d.classification.nonRectangular})`,
  );
  lines.push(`Silent rect no-ops:  ${d.silentNoOps}`);

  if (d.failuresByReason.length > 0) {
    lines.push('');
    lines.push('Failures by reason:');
    for (const r of d.failuresByReason) {
      lines.push(`  ${r.count.toString().padStart(6)}  ${r.reason}`);
    }
  }

  const rf = d.rectFast;
  lines.push('');
  lines.push(
    `rect_fast: fired ${rf.fired}, openings cut ${rf.openingsCut} ` +
      `(defer: host-not-box ${rf.deferHostNotBox}, not-through ${rf.deferNotThrough}, ` +
      `off-face ${rf.deferOffFace}, near-edge ${rf.deferNearEdge}, no-openings ${rf.deferNoOpenings}, ` +
      `too-many ${rf.deferTooManyOpenings ?? 0})`,
  );

  if (d.worstHosts.length > 0) {
    lines.push('');
    lines.push('Worst-failing hosts:');
    for (const h of d.worstHosts) {
      const label = h.firstFailureLabel ? ` [${h.firstFailureLabel}]` : '';
      lines.push(
        `  #${h.productId} ${h.ifcType}: ${h.csgFailures} failure(s), ${h.openings} opening(s)${label}`,
      );
      const detail = formatHostDetail(h);
      if (detail) lines.push(`      ${detail}`);
    }
  }

  return lines.join('\n');
}

/**
 * Render a worst-failing host's optional per-product detail (bbox + triangle
 * count). Both fields are opt-in — only captured when a void cut ran for that
 * host (see `HostBbox`/`triangle_count` in the Rust `WorstHost` contract) — so
 * this returns `undefined` rather than printing "undefined" when neither was
 * recorded.
 */
function formatHostDetail(h: GeometryDiagnostics['worstHosts'][number]): string | undefined {
  const parts: string[] = [];
  if (h.bbox) {
    const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
    parts.push(`bbox=[${h.bbox.min.map(fmt).join(', ')}] – [${h.bbox.max.map(fmt).join(', ')}]`);
  }
  if (h.triangleCount !== undefined) {
    parts.push(`triangles=${h.triangleCount.toLocaleString()}`);
  }
  return parts.length > 0 ? parts.join('  ') : undefined;
}
