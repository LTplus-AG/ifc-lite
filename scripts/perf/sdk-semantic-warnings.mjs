/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Exact canonical semantic diagnostic grammar. Membership alone grants no timing
// eligibility: the hosted driver requires complete, unnormalized paired diagnostics.
// Approximations/omissions remain disclosed; this does not establish faithful IFC.
export const canonicalReasons = new Set([
  'OperandTooLarge', 'EmptyOperand', 'DegenerateOperand', 'NoBoundsOverlap',
  'KernelOutputInvalid', 'SolidSolidDifferenceSkipped', 'PolygonalBoundedHalfSpaceFallback',
  'CutterUnionUnavailable', 'UnknownBooleanOperator', 'OperandBudgetExhausted',
  'ManifoldOutputDegenerate', 'KernelError', 'DifferenceEmptiedHost',
  'OpenTopologyRejected', 'UnsupportedOperand', 'NonManifoldRejected',
]);
function canonicalCsgWarning(text) {
  const headline = /^\[IFC-LITE\] CSG diagnostics: (\d+) openings classified, (\d+) failures, (\d+) hosts tracked$/.exec(text);
  if (headline && headline.slice(1).every(value => Number.isSafeInteger(Number(value))) && Number(headline[2]) > 0) {
    return { kind: 'headline', openings: Number(headline[1]), failures: Number(headline[2]), hosts: Number(headline[3]) };
  }
  const parts = text.split('\nBy host type:\n');
  if (parts.length !== 2) return null;
  const summary = /^\[IFC-LITE\] CSG fallbacks: (\d+) failures across (\d+) products\. Breakdown: \[(.*)\]\.$/.exec(parts[0]);
  if (!summary || !summary.slice(1, 3).every(value => Number.isSafeInteger(Number(value)))
    || Number(summary[1]) < 1) return null;
  const tuples = [...summary[3].matchAll(/\("([A-Za-z]+)", (\d+)\)/g)];
  if (!tuples.length || tuples.length > canonicalReasons.size || tuples.map(item => item[0]).join(', ') !== summary[3]) return null;
  const reasons = tuples.map(item => ({ reason: item[1], count: Number(item[2]) }));
  const total = reasons.reduce((sum, item) => sum + item.count, 0);
  if (new Set(reasons.map(item => item.reason)).size !== reasons.length || !Number.isSafeInteger(total)
    || total !== Number(summary[1]) || reasons.some(item => !canonicalReasons.has(item.reason)
      || !Number.isSafeInteger(item.count) || item.count < 1)) return null;
  const details = parts[1].split('\nWorst-failing hosts (top 10):\n');
  if (details.length !== 2) return null;
  const host = /^  Ifc[A-Za-z0-9]+: hosts=\d+ openings=\d+ \(rect=\d+ diag=\d+ non_rect=\d+\)$/;
  if (details[0] !== '  ' && !details[0].split('\n').every(line => host.test(line))) return null;
  const worst = /^  #\d+ Ifc[A-Za-z0-9]+ — \d+ openings \[(?:(?:Rectangular|Diagonal|NonRectangular)(?:,(?:Rectangular|Diagonal|NonRectangular))*)?\], \d+ CSG failure\(s\) \(([A-Za-z]+|\?)\)$/;
  if (details[1] !== '  (none)' && !details[1].split('\n').every(line => {
    const match = worst.exec(line); return match && (match[1] === '?' || canonicalReasons.has(match[1]));
  })) return null;
  return { kind: 'reason-breakdown', total: Number(summary[1]), attributedProducts: Number(summary[2]), reasons };
}

export function canonicalConsumerSummary(text) {
  const match = /^\[ifc-lite\] (\d+) CSG failure\(s\) across (\d+) product\(s\) this load - see diagnostics\.failuresByReason; not every reason leaves an opening\/void uncut$/.exec(text);
  if (!match || !match.slice(1).every(value => Number.isSafeInteger(Number(value))) || Number(match[1]) < 1) return null;
  return { kind: 'load-headline', total: Number(match[1]), attributedProducts: Number(match[2]) };
}

const layerReasons = new Set([
  'skip:base-mesh-error', 'skip:fewer-than-2-layers', 'skip:not-single-unshifted-item',
  'skip:thin-layers-collapsed-to-1', 'skip:empty-base-mesh', 'skip:placement-unresolved',
  'skip:no-interface-planes', 'skip:cut-produced-<2',
]);
const unsigned = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0;
const positive = value => unsigned(value) && Number(value) > 0;

export function canonicalSemanticWarning(text) {
  const csg = canonicalCsgWarning(text); if (csg) return csg;
  if (text === '[ifc-lite layers] IfcMaterialLayerSet present but no sliceable buildup (LayerSetUsage missing?)') {
    return { kind: 'layer-usage-missing', implication: 'requested layer buildup not sliceable; output faithfulness unasserted' };
  }
  const layer = /^\[ifc-lite layers\] batch: sliced (\d+), (\d+) NOT sliced — (.+)$/.exec(text);
  if (layer) {
    if (!unsigned(layer[1]) || !positive(layer[2])) return null;
    const entries = layer[3].split(', ').map(value => /^#(\d+)=(skip:[a-z0-9:<-]+)$/.exec(value));
    if (entries.length !== Number(layer[2]) || entries.some(item => !item || !positive(item[1])
      || Number(item[1]) > 0xffffffff || !layerReasons.has(item[2]))) return null;
    return { kind: 'layer-slicing', sliced: Number(layer[1]), notSliced: Number(layer[2]),
      entries: entries.map(item => ({ expressId: Number(item[1]), reason: item[2] })),
      implication: 'some requested wall layers unsliced or base geometry absent; not worker retry' };
  }
  const oversized = /^\[IFC-LITE\] (\d+) content-hash reference\(s\) above the u32 express-id bound were refused \(see issue #3421\)$/.exec(text);
  if (oversized) return positive(oversized[1]) ? { kind: 'oversized-content-reference', count: Number(oversized[1]),
    implication: 'unrepresentable references refused; some instancing may be absent' } : null;
  const dropped = /^\[IFC-LITE\] (\d+) representation item\(s\) dropped \(unsupported type or failed geometry\) — these elements are missing or incomplete: (.+)$/.exec(text);
  if (dropped) {
    if (!positive(dropped[1])) return null;
    // Source name() includes unknown exporter IFC identifiers: preserve them as payload,
    // never reinterpret them as an accepted worker-error or CSG-reason label.
    const entries = dropped[2].split(', ').map(value => /^([A-Za-z_][A-Za-z0-9_]*)=(\d+)$/.exec(value));
    if (entries.some(item => !item || !positive(item[2]))) return null;
    const byType = entries.map(item => ({ ifcType: item[1], count: Number(item[2]) }));
    const total = byType.reduce((sum, item) => sum + item.count, 0);
    if (!Number.isSafeInteger(total) || total !== Number(dropped[1])
      || new Set(byType.map(item => item.ifcType)).size !== byType.length) return null;
    return { kind: 'representation-items-dropped', total, byType,
      implication: 'unsupported/failed Body representation items absent; not affected-occurrence census' };
  }
  const noop = /^\[IFC-LITE\] Rectangular cut SILENT NO-OP on (\d+) hosts \(rect boxes processed but mesh unchanged — likely opening box doesn't intersect host\)\. Top (\d+) \(by box count\):\n([\s\S]+)$/.exec(text);
  if (noop) {
    if (!positive(noop[1]) || !positive(noop[2]) || Number(noop[2]) !== Math.min(Number(noop[1]), 8)) return null;
    const number = String.raw`(?:-?\d+\.\d{2}|-?inf|NaN)`;
    const triple = `${number},${number},${number}`;
    const line = new RegExp(String.raw`^  #(\d+) (Ifc[A-Za-z0-9]+) — (\d+) rect boxes, tris=(\d+)→(\d+) \(NO CHANGE\), (host bounds=(?:\?|\(${triple}\)\.\.\(${triple}\)))$`);
    const entries = noop[3].split('\n').map(value => line.exec(value));
    if (entries.length !== Number(noop[2]) || entries.some(item => !item
      || !positive(item[1]) || Number(item[1]) > 0xffffffff || !positive(item[3])
      || !unsigned(item[4]) || !unsigned(item[5]) || item[4] !== item[5])) return null;
    return { kind: 'rectangular-silent-noop', totalHosts: Number(noop[1]), displayedHosts: Number(noop[2]),
      entries: entries.map(item => ({ expressId: Number(item[1]), ifcType: item[2], rectBoxes: Number(item[3]),
        trianglesBefore: Number(item[4]), trianglesAfter: Number(item[5]), boundsText: item[6] })),
      implication: 'attempted rectangular cuts left mesh unchanged; bounded detail is not full inventory' };
  }
  return null;
}
