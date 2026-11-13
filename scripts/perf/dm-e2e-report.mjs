/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reporter for scripts/perf/dm-e2e-ab.mjs: the pure half, so the medians,
// the noise guard and the output-identity rule are unit-testable without
// starting a server (dm-e2e-report.test.mjs).
//
// Same three rules as ab-report.mjs, applied to an END-TO-END server parse
// rather than the perf_probe phases:
//   - MEDIAN, not mean.
//   - NOISE GUARD: the base side's own spread per metric is this machine's
//     noise floor for this run; a delta inside it is "within noise", never a
//     win.
//   - OUTPUT IDENTITY: here it really is byte identity, not a count — each row
//     carries a SHA-256 of the geometry Parquet body and of the data-model
//     Parquet the route cached. A side whose digest moves between rounds is
//     non-deterministic; a digest that differs across sides means the branch
//     changed what the server returns, and no timing delta from that run is a
//     like-for-like comparison.

/** Metrics reported per variant, in pipeline order; peak RSS leads because it
 * is the quantity #9582 is about. `unit` is only for formatting. */
export const METRICS = [
  { key: 'peakRssBytes', label: 'peak RSS', unit: 'MiB', scale: 1 / (1024 * 1024) },
  { key: 'parseMs', label: 'parse', unit: 'ms', scale: 1 },
  { key: 'geometryMs', label: 'geometry', unit: 'ms', scale: 1 },
  { key: 'totalMs', label: 'TOTAL', unit: 'ms', scale: 1 },
];

/** Digests that must agree across sides for a timing delta to mean anything. */
export const DIGESTS = [
  { key: 'geometryDigest', label: 'geometry parquet' },
  { key: 'dataModelDigest', label: 'data-model parquet' },
];

/** Peak RSS in bytes from a `/usr/bin/time` summary.
 *
 * Both dialects, because the flag and the unit differ: BSD/macOS `-l` prints
 * `<bytes>  maximum resident set size`, GNU `-v` prints
 * `Maximum resident set size (kbytes): <KiB>`. Returns null when neither
 * line is present, which the driver treats as a failed measurement rather
 * than a zero.
 */
export function parsePeakRss(stderr) {
  const bsd = String(stderr).match(/^\s*(\d+)\s+maximum resident set size/m);
  if (bsd) return Number(bsd[1]);
  const gnu = String(stderr).match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
  if (gnu) return Number(gnu[1]) * 1024;
  return null;
}

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Max-to-min spread as a percentage of the median: the machine's own noise. */
export const spreadPct = (xs) => {
  if (xs.length < 2) return 0;
  const med = median(xs);
  if (med <= 0) return 0;
  return ((Math.max(...xs) - Math.min(...xs)) / med) * 100;
};

export const pctDelta = (branch, base) => (base > 0 ? ((branch - base) / base) * 100 : null);

export class InvalidRuns extends Error {}

/** Validate and group rows by variant. Throws `InvalidRuns` rather than
 * exiting, so the test can assert the message. */
export function groupRuns(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new InvalidRuns('no runs to report');
  }
  const byVariant = new Map();
  for (const [index, row] of rows.entries()) {
    const at = `run ${index + 1}`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new InvalidRuns(`${at} must be an object`);
    }
    if (row.side !== 'base' && row.side !== 'branch') {
      throw new InvalidRuns(`${at} has side ${JSON.stringify(row.side)}; must be "base" or "branch"`);
    }
    if (typeof row.variant !== 'string' || row.variant.length === 0) {
      throw new InvalidRuns(`${at} is missing the entities variant`);
    }
    for (const { key } of METRICS) {
      if (!Number.isFinite(row[key]) || row[key] < 0) {
        throw new InvalidRuns(`${at} requires a finite nonnegative ${key}`);
      }
    }
    for (const { key } of DIGESTS) {
      if (typeof row[key] !== 'string' || row[key].length === 0) {
        throw new InvalidRuns(`${at} requires a ${key}`);
      }
    }
    if (!byVariant.has(row.variant)) byVariant.set(row.variant, { base: [], branch: [] });
    byVariant.get(row.variant)[row.side].push(row);
  }
  for (const [variant, sides] of byVariant) {
    if (sides.base.length === 0 || sides.branch.length === 0) {
      throw new InvalidRuns(`variant ${variant} needs at least one base and one branch run`);
    }
    // Unequal counts mean the interleaving broke: one side ran in conditions
    // the other never saw, which is the whole thing interleaving prevents.
    if (sides.base.length !== sides.branch.length) {
      throw new InvalidRuns(
        `variant ${variant} has unpaired runs (base ${sides.base.length}, branch ${sides.branch.length})`
      );
    }
  }
  return byVariant;
}

/** Per-variant medians, deltas, noise floor and identity verdict. */
export function summarize(rows, { minRounds = 5 } = {}) {
  const byVariant = groupRuns(rows);
  const variants = [];
  for (const [variant, sides] of byVariant) {
    const metrics = METRICS.map(({ key, label, unit, scale }) => {
      const baseVals = sides.base.map((r) => r[key]);
      const branchVals = sides.branch.map((r) => r[key]);
      const baseMedian = median(baseVals);
      const branchMedian = median(branchVals);
      const delta = pctDelta(branchMedian, baseMedian);
      const noise = baseMedian === 0 ? null : spreadPct(baseVals);
      // "Real" on the same terms as ab-report: outside the base's own spread
      // and outside a 3% floor, so a 1% move on a quiet machine is still
      // reported as noise rather than a win.
      const real = delta != null && noise != null && Math.abs(delta) > Math.max(noise, 3);
      return {
        key,
        label,
        unit,
        baseMedian: baseMedian * scale,
        branchMedian: branchMedian * scale,
        deltaPct: delta,
        noisePct: noise,
        real,
        direction: delta == null ? null : delta < 0 ? 'lower' : delta > 0 ? 'higher' : 'unchanged',
      };
    });

    const identity = DIGESTS.map(({ key, label }) => {
      const base = [...new Set(sides.base.map((r) => r[key]))];
      const branch = [...new Set(sides.branch.map((r) => r[key]))];
      return {
        key,
        label,
        base,
        branch,
        // Non-constant within a side is non-determinism, and it is a different
        // defect from the two sides disagreeing. Report which one happened.
        unstable: base.length > 1 || branch.length > 1,
        agrees: base.length === 1 && branch.length === 1 && base[0] === branch[0],
      };
    });

    variants.push({
      variant,
      rounds: sides.base.length,
      metrics,
      identity,
      // The route's `entity_count` is the MODEL's instance count, not the
      // rows served: #9582 keeps it `total_entities` on purpose, so the one
      // metadata header both variants share can never disagree with either
      // (#6034). It must therefore be the same number for both variants and
      // on both sides, and this is where that is visible.
      entityCount: [...new Set([...sides.base, ...sides.branch].map((r) => r.totalEntities))],
      // How much data-model Parquet the variant actually ships. The digests
      // above already pin the bytes; this is the size behind them, and it is
      // what tells `rooted` apart from `all` in the table.
      dataModelBytes: [...new Set([...sides.base, ...sides.branch].map((r) => r.dataModelBytes))],
    });
  }

  const identityBroken = variants.some((v) => v.identity.some((d) => !d.agrees));
  const unstable = variants.some((v) => v.identity.some((d) => d.unstable));
  const tooNoisy = variants.some((v) => {
    const total = v.metrics.find((m) => m.key === 'totalMs');
    return total?.noisePct != null && total.noisePct > 15;
  });
  const underSampled = variants.some((v) => v.rounds < minRounds);

  return { variants, identityBroken, unstable, tooNoisy, underSampled, minRounds };
}

const fmt = (n) => (n == null ? '—' : Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1));
const signed = (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);

/** The human table. Returns lines; the driver prints them. */
export function formatReport(summary, { base = 'base', branch = 'branch', fixture = '', fileBytes = null } = {}) {
  const lines = [];
  const size = fileBytes == null ? '' : `  (${(fileBytes / 1e6).toFixed(0)} MB)`;
  lines.push('');
  lines.push(`end-to-end server parse A/B  base=${base}  branch=${branch}`);
  lines.push(`  fixture: ${fixture}${size}`);
  for (const v of summary.variants) {
    lines.push('');
    lines.push(`  data_model_entities=${v.variant}   ${v.rounds} interleaved round(s) per side`);
    lines.push(`    ${'metric'.padEnd(12)} ${base.padStart(11)} ${branch.padStart(11)}    delta    noise`);
    for (const m of v.metrics) {
      const tag = m.real ? (m.direction === 'lower' ? '  ✅' : '  ⛔') : '  ·';
      const noise = m.noisePct == null ? '—' : `±${m.noisePct.toFixed(0)}%`;
      lines.push(
        `    ${`${m.label} (${m.unit})`.padEnd(12)} ${fmt(m.baseMedian).padStart(11)} ${fmt(m.branchMedian).padStart(11)}  ${signed(m.deltaPct).padStart(7)}  ${noise.padStart(6)}${tag}`
      );
    }
    for (const d of v.identity) {
      if (d.unstable) {
        lines.push(`    ⚠️  ${d.label} digest varied BETWEEN ROUNDS (base ${d.base.length}, branch ${d.branch.length} distinct) — the pipeline is not deterministic on this run.`);
      } else if (!d.agrees) {
        lines.push(`    ⚠️  ${d.label} digest DIFFERS: ${d.base[0].slice(0, 12)} → ${d.branch[0].slice(0, 12)}`);
      } else {
        lines.push(`    ✓ ${d.label} byte-identical across sides (sha256 ${d.base[0].slice(0, 12)}…)`);
      }
    }
    if (v.entityCount.length > 1) {
      lines.push(`    ⚠️  reported entity_count disagrees across runs: ${v.entityCount.join(' / ')} — it must describe the MODEL, not the served variant (#6034).`);
    } else if (v.entityCount[0] != null) {
      lines.push(`    reported entity_count ${v.entityCount[0].toLocaleString('en-US')} instances (the model, not the served rows)`);
    }
    if (v.dataModelBytes.length === 1 && v.dataModelBytes[0] != null) {
      lines.push(`    data-model parquet ${v.dataModelBytes[0].toLocaleString('en-US')} bytes`);
    }
  }

  lines.push('');
  if (summary.identityBroken || summary.unstable) {
    lines.push('VERDICT: ⚠️  output identity failed — the timing and memory deltas above are NOT like-for-like.');
  } else if (summary.tooNoisy) {
    lines.push('VERDICT: ⚠️  too noisy to call — the base side\'s own TOTAL spread exceeds 15%. Re-run on an idle machine.');
  } else {
    const wins = summary.variants.flatMap((v) => v.metrics.filter((m) => m.real).map((m) => `${v.variant}/${m.label} ${signed(m.deltaPct)}`));
    lines.push(wins.length ? `VERDICT: output identical on both sides; real moves: ${wins.join(', ')}.` : 'VERDICT: output identical on both sides; every metric is within this machine\'s noise.');
  }
  if (summary.underSampled) {
    lines.push(`NOTE: fewer than ${summary.minRounds} rounds per side — this is a smoke run, not acceptance evidence.`);
  }
  return lines;
}
