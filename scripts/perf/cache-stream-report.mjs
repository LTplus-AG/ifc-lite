/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reporter for scripts/perf/cache-stream-ab.mjs (#9584): the pure half, so
// the medians, the noise guard, the identity rule and the markdown table are
// unit-testable without building a single binary (cache-stream-report.test.mjs).
//
// The question this answers is NOT "is the streaming writer faster". It is
// the acceptance question for the native `.ifclite` cache: does streaming the
// geometry to disk lower the PROCESS peak, and how much of whatever moved is
// the writer's doing rather than the rest of the pipeline's.
//
// That needs three measurements per model, not two:
//
//   base-inmem     the merge base's in-memory `build_cache`  — the baseline
//   head-inmem     the head's in-memory `build_cache`        — the CONTROL
//   head-streamed  the head's `build_cache_to_path`          — the claim
//
// Without the control, every byte the head moved (source mapping, data-model
// changes, anything else that rode in on the branch) is attributed to the
// streaming writer. base→head-inmem is that confound measured on its own;
// head-inmem→head-streamed is the writer's own saving.
//
// The three rules are ab-report.mjs's, applied per model:
//   - MEDIAN, not mean.
//   - NOISE GUARD: the noisier of the two sides being compared is that
//     comparison's floor, and never below 3%. Taking only the baseline's
//     spread would call a delta real against a side that was itself swinging
//     wider than the delta.
//   - OUTPUT IDENTITY: byte identity, by sha256 of the written `.ifclite`.
//     All three variants must agree, on every round. They are three writers
//     of ONE format: a peak that fell because the head wrote different bytes
//     is not a saving, and a hash that moves between rounds of one variant is
//     non-determinism, which is a different defect from the variants
//     disagreeing. The report says which happened.

// The generic helpers have a single home in dm-e2e-report.mjs (the first
// harness to need them); importing them keeps one definition of "median" and
// one parser for the two `/usr/bin/time` dialects.
import { median, parsePeakRss, pctDelta, spreadPct } from './dm-e2e-report.mjs';

export { median, parsePeakRss, pctDelta, spreadPct };

/** The three builds compared per model, in report order. */
export const VARIANTS = [
  { key: 'base-inmem', label: 'baseline in-memory', ref: 'base', writer: 'build_cache' },
  { key: 'head-inmem', label: 'head in-memory', ref: 'head', writer: 'build_cache' },
  { key: 'head-streamed', label: 'head streamed', ref: 'head', writer: 'build_cache_to_path' },
];

export const VARIANT_KEYS = VARIANTS.map((v) => v.key);

/** The variant every acceptance delta is measured against. */
export const BASELINE = 'base-inmem';

/** Metrics per variant. Peak RSS leads: it is the quantity #9584 is about. */
export const METRICS = [
  { key: 'peakRssBytes', label: 'peak RSS', unit: 'MiB', scale: 1 / (1024 * 1024) },
  { key: 'elapsedMs', label: 'elapsed', unit: 's', scale: 1 / 1000 },
];

/** The three readings a verdict needs, and what each one separates. */
export const COMPARISONS = [
  { from: 'base-inmem', to: 'head-streamed', label: 'streamed vs baseline', why: 'the acceptance claim' },
  { from: 'base-inmem', to: 'head-inmem', label: 'head in-memory vs baseline', why: 'the branch minus the writer' },
  { from: 'head-inmem', to: 'head-streamed', label: 'streamed vs head in-memory', why: "the writer's own saving" },
];

/** Stats the CLI and the conformance writer print, carried into the table. */
export const STATS = [
  { key: 'meshCount', label: 'meshes' },
  { key: 'chunkCells', label: 'chunkCells' },
  { key: 'peakOpenChunkBytes', label: 'peakOpenChunkBytes' },
  { key: 'cacheBytes', label: 'cacheBytes' },
];

/**
 * The file one run writes its cache to. With `--keep-outputs` every run's
 * output is kept side by side, so the name carries the fixture (its index,
 * which is unique, and its name, which is readable) as well as the variant
 * and round: a second model must not overwrite the first model's outputs.
 */
export function outputName({ fixtureIndex, model, variant, round }) {
  const stem = model.split('/').pop().replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '_');
  return `${String(fixtureIndex).padStart(2, '0')}-${stem}-${variant}-r${round}.ifclite`;
}

/**
 * Within-round execution order, balanced across rounds.
 *
 * ab-order.mjs solves this for TWO sides; three variants need the same
 * property and cannot use it. A fixed order would hand whichever variant runs
 * first every position-tied penalty there is — the cold page cache of a 327 MB
 * source, a frequency step on the first process after idle — and the median
 * would carry it (ab-order.mjs's header has the commit that measured itself
 * 23.5% faster this way). Rotations make each variant lead as close to
 * `iters / 3` times as the round count allows; shuffling which round gets
 * which rotation keeps the position assignment from resonating with a
 * periodic effect on the host.
 *
 * @param {number} iters positive integer round count
 * @param {string[]} keys variant keys, in canonical order
 * @param {() => number} rand uniform [0,1) generator
 * @returns {string[][]} one ordering per round
 */
export function variantOrder(iters, keys = VARIANT_KEYS, rand = Math.random) {
  if (!Number.isInteger(iters) || iters < 1) {
    throw new Error(`variantOrder: iters must be a positive integer (got ${iters})`);
  }
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('variantOrder: needs at least one variant key');
  }
  const rotations = Array.from({ length: iters }, (_, i) => i % keys.length);
  for (let i = rotations.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [rotations[i], rotations[j]] = [rotations[j], rotations[i]];
  }
  return rotations.map((r) => [...keys.slice(r), ...keys.slice(0, r)]);
}

export class InvalidRuns extends Error {}

/**
 * Validate rows and group them model → variant. A row with `status` other
 * than `ok` is a run that FAILED (a refusal, an OOM kill, a missing peak); it
 * is kept as data — on a 327 MB model a refusal is the finding — but it never
 * enters a median.
 */
export function groupRuns(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new InvalidRuns('no runs to report');
  const byModel = new Map();
  for (const [index, row] of rows.entries()) {
    const at = `run ${index + 1}`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new InvalidRuns(`${at} must be an object`);
    if (typeof row.model !== 'string' || row.model.length === 0) throw new InvalidRuns(`${at} is missing the model`);
    if (!VARIANT_KEYS.includes(row.variant)) {
      throw new InvalidRuns(`${at} has variant ${JSON.stringify(row.variant)}; must be one of ${VARIANT_KEYS.join(', ')}`);
    }
    if (!Number.isInteger(row.round) || row.round < 1) throw new InvalidRuns(`${at} needs a positive integer round`);
    if (!byModel.has(row.model)) {
      byModel.set(row.model, { ok: new Map(VARIANT_KEYS.map((k) => [k, []])), failures: [] });
    }
    const model = byModel.get(row.model);
    if (row.status !== 'ok') {
      model.failures.push(row);
      continue;
    }
    for (const { key } of METRICS) {
      if (!Number.isFinite(row[key]) || row[key] < 0) throw new InvalidRuns(`${at} requires a finite nonnegative ${key}`);
    }
    if (typeof row.outputSha256 !== 'string' || row.outputSha256.length === 0) {
      throw new InvalidRuns(`${at} requires an outputSha256`);
    }
    model.ok.get(row.variant).push(row);
  }
  return byModel;
}

/** Distinct values of `key` over rows, nulls dropped. */
const distinct = (rows, key) => [...new Set(rows.map((r) => r.stats?.[key]).filter((v) => v != null))];

function variantSummary(key, rows) {
  const spec = VARIANTS.find((v) => v.key === key);
  return {
    variant: key,
    label: spec.label,
    writer: spec.writer,
    rounds: rows.length,
    metrics: METRICS.map(({ key: metric, label, unit, scale }) => {
      const values = rows.map((r) => r[metric]);
      return {
        key: metric,
        label,
        unit,
        median: values.length ? median(values) * scale : null,
        rawMedian: values.length ? median(values) : null,
        spreadPct: values.length ? spreadPct(values) : null,
      };
    }),
    hashes: [...new Set(rows.map((r) => r.outputSha256))],
    stats: Object.fromEntries(STATS.map(({ key: s }) => [s, distinct(rows, s)])),
  };
}

function comparisons(variants) {
  const byKey = new Map(variants.map((v) => [v.variant, v]));
  const out = [];
  for (const { from, to, label, why } of COMPARISONS) {
    const a = byKey.get(from);
    const b = byKey.get(to);
    if (!a?.rounds || !b?.rounds) continue;
    for (const { key: metric, label: metricLabel, unit } of METRICS) {
      const fromStat = a.metrics.find((m) => m.key === metric);
      const toStat = b.metrics.find((m) => m.key === metric);
      const deltaPct = pctDelta(toStat.rawMedian, fromStat.rawMedian);
      // The noisier of the two sides, never below 3%: a delta smaller than
      // the swing of either side it was computed from is not a reading.
      const noisePct = Math.max(fromStat.spreadPct ?? 0, toStat.spreadPct ?? 0);
      const real = deltaPct != null && Math.abs(deltaPct) > Math.max(noisePct, 3);
      out.push({
        from, to, label, why, metric, metricLabel, unit, deltaPct, noisePct, real,
        direction: deltaPct == null ? null : deltaPct < 0 ? 'lower' : deltaPct > 0 ? 'higher' : 'unchanged',
      });
    }
  }
  return out;
}

/** Per-model medians, deltas, noise floor and byte-identity verdict. */
export function summarize(rows, { minRounds = 5 } = {}) {
  const byModel = groupRuns(rows);
  const models = [];
  for (const [model, { ok, failures }] of byModel) {
    const variants = VARIANT_KEYS.map((key) => variantSummary(key, ok.get(key)));
    const measured = variants.filter((v) => v.rounds > 0);
    const hashes = [...new Set(measured.flatMap((v) => v.hashes))];
    models.push({
      model,
      variants,
      comparisons: comparisons(variants),
      failures,
      // A variant with no successful run cannot be compared, and a model
      // missing one is not a paired result however good the other two look.
      incomplete: measured.length < VARIANT_KEYS.length,
      missing: variants.filter((v) => v.rounds === 0).map((v) => v.variant),
      rounds: Math.min(...variants.map((v) => v.rounds)),
      identity: {
        hashes,
        // Three-way identity needs an output from all three writers, and a
        // disagreement needs two different outputs to disagree. A model with
        // a writer missing and the rest agreeing (or no output at all) is
        // neither: it is unverified, and `incomplete` already fails the run.
        agrees: measured.length === VARIANT_KEYS.length && hashes.length === 1,
        disagrees: hashes.length >= 2,
        // Non-constant WITHIN one variant is non-determinism; the variants
        // disagreeing is a changed output. They are different defects.
        unstable: measured.some((v) => v.hashes.length > 1),
        perVariant: Object.fromEntries(measured.map((v) => [v.variant, v.hashes])),
      },
      meshCounts: [...new Set(measured.flatMap((v) => v.stats.meshCount))],
    });
  }
  const identityBroken = models.some((m) => m.identity.disagrees);
  const unstable = models.some((m) => m.identity.unstable);
  const incomplete = models.some((m) => m.incomplete);
  const underSampled = models.some((m) => m.rounds > 0 && m.rounds < minRounds);
  const tooNoisy = models.some((m) =>
    m.variants.some((v) => v.metrics.some((metric) => metric.key === 'peakRssBytes' && metric.spreadPct != null && metric.spreadPct > 15))
  );
  return { models, identityBroken, unstable, incomplete, underSampled, tooNoisy, minRounds };
}

const fmt = (n) => (n == null ? '—' : Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1));
const signed = (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);
const list = (xs) => (xs.length === 0 ? '—' : xs.map((x) => (typeof x === 'number' ? x.toLocaleString('en-US') : x)).join(' / '));

function provenanceLines(p) {
  const lines = ['### Provenance', ''];
  lines.push(`- **merge base** \`${p.baseSha ?? '?'}\` · **head** \`${p.headSha ?? '?'}\``);
  lines.push(`- **profile** \`${p.profile ?? '?'}\` · **RAYON_NUM_THREADS** \`${p.threads ?? '?'}\` · **rounds** ${p.iters ?? '?'} interleaved per variant`);
  if (p.toolchain) lines.push(`- **toolchain** \`${p.toolchain}\`${p.toolchainPinned ? ` (pinned \`${p.toolchainPinned}\`, identical at both refs)` : ''}`);
  if (p.host) lines.push(`- **host** ${p.host}`);
  if (p.loadavg) lines.push(`- **host load (1 min) over the run** ${p.loadavg}`);
  if (p.startedAt) lines.push(`- **run** ${p.startedAt}${p.finishedAt ? ` → ${p.finishedAt}` : ''}`);
  if (p.fixtures?.length) {
    lines.push('');
    lines.push('| fixture | bytes | sha256 (on disk) | matches catalog |');
    lines.push('|---|---:|---|---|');
    for (const f of p.fixtures) {
      lines.push(`| \`${f.path}\` | ${f.sizeBytes?.toLocaleString('en-US') ?? '—'} | \`${f.sha256?.slice(0, 16) ?? '—'}…\` | ${f.matchesManifest ? 'yes' : '**NO**'} |`);
    }
  }
  return lines;
}

function modelLines(m) {
  const lines = ['', `### ${m.model}`, ''];
  lines.push(`| variant | writer | peak RSS (MiB) | spread | elapsed (s) | meshes | chunkCells | peakOpenChunkBytes | output sha256 |`);
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---|');
  for (const v of m.variants) {
    if (v.rounds === 0) {
      lines.push(`| ${v.label} | \`${v.writer}\` | — | — | — | — | — | — | **no successful run** |`);
      continue;
    }
    const rss = v.metrics.find((x) => x.key === 'peakRssBytes');
    const el = v.metrics.find((x) => x.key === 'elapsedMs');
    const hash = v.hashes.length === 1 ? `\`${v.hashes[0].slice(0, 16)}…\`` : `**${v.hashes.length} distinct**`;
    lines.push(
      `| ${v.label} | \`${v.writer}\` | ${fmt(rss.median)} | ±${(rss.spreadPct ?? 0).toFixed(0)}% | ${fmt(el.median)} | ` +
      `${list(v.stats.meshCount)} | ${list(v.stats.chunkCells)} | ${list(v.stats.peakOpenChunkBytes)} | ${hash} |`
    );
  }
  lines.push('');
  for (const c of m.comparisons) {
    const tag = c.real ? (c.direction === 'lower' ? '✅' : '⛔') : '·';
    lines.push(`- ${tag} **${c.label}**, ${c.metricLabel}: ${signed(c.deltaPct)} (noise floor ±${(c.noisePct ?? 0).toFixed(0)}%) — ${c.why}`);
  }
  if (m.failures.length > 0) {
    lines.push('');
    for (const f of m.failures) {
      lines.push(`- ⛔ **${f.variant}** round ${f.round} failed: ${String(f.error ?? f.status).split('\n')[0].slice(0, 200)}`);
    }
  }
  if (m.identity.unstable) {
    lines.push('');
    lines.push('- ⚠️ one variant wrote **different bytes between rounds** — the writer is not deterministic on this host, and no delta above is like-for-like.');
  } else if (m.identity.disagrees) {
    const detail = Object.entries(m.identity.perVariant).map(([k, h]) => `${k} ${h[0].slice(0, 12)}`).join(' · ');
    lines.push('');
    lines.push(`- ⚠️ the three writers **disagree on the bytes**: ${detail}. A peak that moved while the output moved is not a saving.`);
  } else if (!m.identity.agrees) {
    const wrote = m.variants.filter((v) => v.rounds > 0).map((v) => v.variant);
    lines.push('');
    lines.push(
      `- ⚠️ byte identity is **not established**: only ${wrote.length} of ${VARIANT_KEYS.length} writers produced output` +
      `${wrote.length ? ` (${wrote.join(', ')})` : ''}, so there is nothing to compare the missing ones against.`
    );
  } else {
    lines.push(`- ✓ all three writers wrote **byte-identical** output (sha256 \`${m.identity.hashes[0].slice(0, 16)}…\`), mesh count ${list(m.meshCounts)}.`);
  }
  return lines;
}

/** The markdown report, for pasting into the PR. Returns lines. */
export function formatReport(summary, provenance = {}) {
  const lines = ['## Paired native cache RSS run (#9584)', ''];
  lines.push(...provenanceLines(provenance));
  for (const m of summary.models) lines.push(...modelLines(m));
  lines.push('', '### Verdict', '');
  if (summary.identityBroken || summary.unstable) {
    lines.push('⚠️ **Output identity failed.** The memory and timing deltas above are not like-for-like and this run is not acceptance evidence.');
  } else if (summary.incomplete) {
    lines.push('⚠️ **Incomplete.** At least one variant has no successful run on some model, so that model is not a paired result. See the failures above.');
  } else if (summary.tooNoisy) {
    lines.push("⚠️ **Too noisy to call.** The baseline's own peak-RSS spread exceeds 15% on at least one model. Re-run under admission on an idle host.");
  } else {
    lines.push('Output byte-identical across all three writers on every model. Streamed vs baseline peak RSS:');
    lines.push('');
    for (const m of summary.models) {
      const claim = m.comparisons.find((c) => c.from === BASELINE && c.to === 'head-streamed' && c.metric === 'peakRssBytes');
      const read = !claim?.real ? 'within noise' : claim.direction === 'lower' ? '**a real saving**' : '**a real increase**';
      lines.push(`- \`${m.model}\`: ${signed(claim?.deltaPct)} — ${read} (floor ±${(claim?.noisePct ?? 0).toFixed(0)}%)`);
    }
    // The acceptance claim is base→streamed, but a real move in either other
    // comparison is what says WHERE a saving came from — and an increase in
    // one of them does not belong in a footnote under a passing verdict.
    const others = summary.models.flatMap((m) =>
      m.comparisons.filter((c) => c.real && !(c.from === BASELINE && c.to === 'head-streamed'))
        .map((c) => `${m.model.split('/').pop()} ${c.label} ${c.metricLabel} ${signed(c.deltaPct)}`)
    );
    if (others.length > 0) {
      lines.push('');
      lines.push(`Other moves outside noise: ${others.join('; ')}.`);
    }
  }
  if (summary.underSampled) {
    lines.push('');
    lines.push(`**NOTE:** fewer than ${summary.minRounds} rounds per variant — this is a smoke run, not acceptance evidence.`);
  }
  return lines;
}
