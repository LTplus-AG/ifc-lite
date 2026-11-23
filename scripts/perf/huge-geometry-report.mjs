/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure statistics and markdown for the huge-geometry harness: frame-time
 * summaries, the per-run summary row, the ladder table and a before/after
 * comparison of two result sets (for spike lanes rerunning the baseline).
 */

/** Nearest-rank percentile (q in [0, 1]) of a numeric array; null when empty. */
export function percentile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
}

const round = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/**
 * Frame records of one camera path -> frame time distribution from rAF
 * timestamp deltas (what a user sees), plus per-frame GPU submission.
 */
export function frameSummary(records) {
  const deltas = [];
  for (let i = 1; i < records.length; i++) deltas.push(records[i].ts - records[i - 1].ts);
  const col = (k) => records.map((r) => r[k]).filter(Number.isFinite);
  const rendered = records.filter((r) => r.presents > 0).length;
  const spanMs = records.length > 1 ? records.at(-1).ts - records[0].ts : null;
  return {
    frames: records.length, rendered,
    fps: spanMs ? round(((records.length - 1) * 1000) / spanMs) : null,
    frameMs: { median: round(percentile(deltas, 0.5), 2), p95: round(percentile(deltas, 0.95), 2), p99: round(percentile(deltas, 0.99), 2),
      worst: round(deltas.length ? Math.max(...deltas) : null, 2) },
    cpuMs: { median: round(percentile(col('cpuMs'), 0.5), 2), p95: round(percentile(col('cpuMs'), 0.95), 2) },
    callbackMs: { median: round(percentile(col('cbMs'), 0.5), 2), p95: round(percentile(col('cbMs'), 0.95), 2) },
    drawsPerFrame: { median: percentile(col('draws'), 0.5), max: col('draws').length ? Math.max(...col('draws')) : null },
    trianglesPerFrame: { median: round(percentile(col('tris'), 0.5), 0), max: col('tris').length ? Math.round(Math.max(...col('tris'))) : null },
    batchesPerFrame: percentile(col('batches'), 0.5), instancedPerFrame: percentile(col('instanced'), 0.5),
    culledPerFrame: percentile(col('culled'), 0.5), indirectDraws: col('indirect').reduce((a, b) => a + b, 0),
  };
}

const mib = (b) => (Number.isFinite(b) ? round(b / 2 ** 20, 0) : null);
const median = (xs) => percentile(xs.filter(Number.isFinite), 0.5);

/** One flat row per run result: the numbers the ladder table and comparisons use. */
export function summaryRow(r) {
  const t = r.load?.timings ?? {};
  const m = r.memory ?? {};
  const cam = r.camera ?? {};
  const it = r.interactions ?? {};
  const hits = (it.picks ?? []).filter((p) => p.hit);
  return {
    name: r.scenario?.name, scenario: r.scenario?.scenario, tier: r.scenario?.nominal, elements: r.generated?.totals?.elements ?? r.scenario?.elements,
    models: r.scenario?.models, fileMiB: mib(r.generated?.totals?.bytes), sceneTriangles: m.scene?.triangles ?? null,
    status: r.status, failure: r.failure ? `${r.failure.kind}: ${r.failure.detail}` : null,
    firstFrameS: round((t.firstFrameMs ?? NaN) / 1000, 2), completeS: round((t.interactiveMs ?? NaN) / 1000, 2),
    geometryS: round((t.geometryMs ?? NaN) / 1000, 2), metadataS: round((t.propsMs ?? NaN) / 1000, 2),
    peakHeapMiB: round(r.sampling?.peak?.jsHeapMiB, 0), settledHeapMiB: round(m.settled?.jsHeapMiB, 0),
    peakRendererPssMiB: round(r.sampling?.peak?.rendererPssMiB, 0), peakGpuProcPssMiB: round(r.sampling?.peak?.gpuPssMiB, 0),
    peakTotalPssMiB: round(r.sampling?.peak?.totalPssMiB, 0), peakVramMiB: r.sampling?.peak?.vramMiB || null,
    wasmMainMiB: mib(m.wasmMainThread?.bytes), gpuSceneMiB: mib(m.scene?.gpuBytes?.total), cpuSceneMiB: mib(m.scene?.cpuBytes?.total ?? m.scene?.cpuBytes),
    drawCalls: m.scene?.frame?.drawCalls ?? null, batches: m.scene?.frame?.batchesDrawn ?? null, instanced: m.scene?.frame?.instancedDrawn ?? null,
    orbitMedianMs: cam.orbit?.frameMs?.median ?? null, orbitP95Ms: cam.orbit?.frameMs?.p95 ?? null, orbitP99Ms: cam.orbit?.frameMs?.p99 ?? null,
    orbitWorstMs: cam.orbit?.frameMs?.worst ?? null, zoomP95Ms: cam.zoom?.frameMs?.p95 ?? null, flyP95Ms: cam.fly?.frameMs?.p95 ?? null,
    trisPerFrame: cam.orbit?.trianglesPerFrame?.median ?? null, drawsPerFrame: cam.orbit?.drawsPerFrame?.median ?? null,
    pickMs: round(median(hits.map((p) => p.frameDoneMs ?? p.ms)), 1), pickHits: `${hits.length}/${(it.picks ?? []).length}`,
    hideMs: round(it.hideOne?.doneMs, 1), isolateMs: round(it.isolate?.doneMs, 1), sectionMs: round(it.sectionOn?.doneMs, 1),
  };
}

const cell = (v) => (v === null || v === undefined ? '–' : String(v));
const COLUMNS = [
  ['scenario', 'scenario'], ['tier', 'tier'], ['elements', 'elements'], ['sceneTriangles', 'scene tris'], ['fileMiB', 'file MiB'],
  ['status', 'status'], ['firstFrameS', 'first frame s'], ['completeS', 'complete s'], ['peakHeapMiB', 'peak JS heap MiB'],
  ['settledHeapMiB', 'settled heap MiB'], ['peakRendererPssMiB', 'peak renderer PSS MiB'], ['peakGpuProcPssMiB', 'peak GPU-proc PSS MiB'],
  ['peakVramMiB', 'peak VRAM MiB'], ['gpuSceneMiB', 'scene GPU MiB'], ['drawCalls', 'draws'], ['trisPerFrame', 'tris/frame'],
  ['orbitMedianMs', 'orbit med ms'], ['orbitP95Ms', 'orbit p95'], ['orbitP99Ms', 'orbit p99'], ['orbitWorstMs', 'orbit worst'],
  ['zoomP95Ms', 'zoom p95'], ['flyP95Ms', 'fly p95'], ['pickMs', 'pick ms'], ['hideMs', 'hide ms'], ['isolateMs', 'isolate ms'], ['sectionMs', 'section ms'],
];

/** Markdown ladder table (one row per run) plus a failure list. */
export function markdownSummary(results, { title = 'Huge-geometry ladder', label = '', host = '' } = {}) {
  const rows = results.map(summaryRow);
  const lines = [`# ${title}${label ? ` (${label})` : ''}`, '', host ? `Host: ${host}` : '', '',
    `| ${COLUMNS.map(([, h]) => h).join(' | ')} |`, `|${COLUMNS.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${COLUMNS.map(([k]) => cell(r[k])).join(' | ')} |`), ''];
  const failed = rows.filter((r) => r.failure);
  if (failed.length) lines.push('## Failures', '', ...failed.map((r) => `- **${r.name}**: ${r.failure}`), '');
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

const COMPARE = [['completeS', 'complete s'], ['peakTotalPssMiB', 'peak PSS MiB'], ['orbitP95Ms', 'orbit p95 ms'], ['zoomP95Ms', 'zoom p95 ms'],
  ['flyP95Ms', 'fly p95 ms'], ['pickMs', 'pick ms'], ['isolateMs', 'isolate ms']];

/** Before/after table keyed by run name: base value, new value, ratio new/base. */
export function markdownCompare(base, next, { baseLabel = 'base', nextLabel = 'next' } = {}) {
  const b = new Map(base.map((r) => [summaryRow(r).name, summaryRow(r)]));
  const lines = [`# ${nextLabel} vs ${baseLabel}`, '', `| run | status | ${COMPARE.map(([, h]) => `${h} (${baseLabel} → ${nextLabel}, ×)`).join(' | ')} |`,
    `|---|---|${COMPARE.map(() => '---').join('|')}|`];
  for (const n of next.map(summaryRow)) {
    const o = b.get(n.name);
    const cells = COMPARE.map(([k]) => {
      const x = o?.[k], y = n[k];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return `${cell(x)} → ${cell(y)}`;
      return `${x} → ${y} (×${round(y / x, 2)})`;
    });
    lines.push(`| ${n.name} | ${o ? `${o.status} → ${n.status}` : `new: ${n.status}`} | ${cells.join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}
