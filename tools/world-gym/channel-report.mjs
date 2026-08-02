#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reward-channel discrimination report over a labeled corpus.
 *
 * Streams manifest.jsonl, computes the five reward channels
 * (lib/reward-channels.mjs) for every model, and reports per-channel value
 * distributions split by label class (clean vs corrupted) - the proof that
 * the channels are discriminative, not constants.
 *
 * Determinism channel cost control: regenerating every model just to
 * re-hash it is O(corpus); by default only models with `seed % 10 == 0`
 * (a deterministic 10% slice) are re-proven, plus EVERY corrupted model in
 * that slice. On top of that, a tamper probe flips one byte in the
 * regenerated content for a 100-model sample and asserts the channel drops
 * to 0 - evidence the channel discriminates real reproductions from
 * near-misses rather than being constant-1 by construction.
 *
 * Usage:
 *   node channel-report.mjs --manifest <path/manifest.jsonl> [--out <report.json>] [--determinism-every 10] [--tamper-sample 100]
 */

import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { computeRewardChannels, CHANNEL_NAMES } from './lib/reward-channels.mjs';
import { generateModel } from './generator.mjs';
import { getFlag, numberFlag } from './lib/flags.mjs';

class ChannelStats {
  constructor() {
    this.count = 0;
    this.nullCount = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.valueCounts = new Map(); // rounded value -> count
  }

  add(v) {
    if (v === null || v === undefined) {
      this.nullCount++;
      return;
    }
    this.count++;
    this.sum += v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
    const key = Math.round(v * 1000) / 1000;
    this.valueCounts.set(key, (this.valueCounts.get(key) ?? 0) + 1);
  }

  summary() {
    const values = [...this.valueCounts.entries()].sort((a, b) => a[0] - b[0]);
    // Cap the histogram at the 20 most frequent values plus explicit min/max.
    const top = [...this.valueCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
      .sort((a, b) => a[0] - b[0]);
    return {
      evaluated: this.count,
      skipped: this.nullCount,
      distinctValues: this.valueCounts.size,
      min: this.count ? this.min : null,
      max: this.count ? this.max : null,
      mean: this.count ? Number((this.sum / this.count).toFixed(6)) : null,
      // Only a channel that was actually evaluated can be "constant"; a
      // zero-evaluated (all-null) channel must not read as flat.
      constant: this.count > 0 && this.valueCounts.size <= 1,
      histogram: Object.fromEntries(top.map(([v, c]) => [String(v), c])),
      histogramTruncated: values.length > top.length,
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const manifestPath = getFlag(args, '--manifest');
  if (!manifestPath) {
    process.stderr.write('Usage: node channel-report.mjs --manifest <manifest.jsonl> [--out <report.json>] [--determinism-every 10] [--tamper-sample 100]\n');
    process.exit(1);
  }
  const outPath = getFlag(args, '--out');
  const determinismEvery = numberFlag(args, '--determinism-every', { def: 10, min: 0, integer: true });
  const tamperSampleTarget = numberFlag(args, '--tamper-sample', { def: 100, min: 0, integer: true });

  const stats = {
    all: Object.fromEntries(CHANNEL_NAMES.map((n) => [n, new ChannelStats()])),
    clean: Object.fromEntries(CHANNEL_NAMES.map((n) => [n, new ChannelStats()])),
    corrupted: Object.fromEntries(CHANNEL_NAMES.map((n) => [n, new ChannelStats()])),
  };
  let total = 0;
  let determinismChecked = 0;
  let determinismFailures = [];
  let tamperChecked = 0;
  let tamperNotZero = [];

  const rl = createInterface({ input: createReadStream(manifestPath, 'utf-8'), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw.trim()) continue;
    const line = JSON.parse(raw);
    total++;

    // Only lines with a numeric seed can be re-proven: the tamper/determinism
    // slice REGENERATES from `line.seed`, so a line without one must be
    // excluded from the slice entirely (a positional fallback here would
    // select lines that then regenerate from `undefined`).
    const numericSeed = typeof line.seed === 'number' ? line.seed : null;
    const proveDeterminism = determinismEvery > 0 && numericSeed !== null && numericSeed % determinismEvery === 0;

    let channels;
    if (proveDeterminism) {
      channels = computeRewardChannels(line);
      determinismChecked++;
      if (channels.determinismHashMatch !== 1) {
        determinismFailures.push(line.seed);
      }
      // Tamper probe on the same regeneration slice until the sample is filled.
      if (tamperChecked < tamperSampleTarget) {
        const regen = generateModel(line.seed, line.family, { forceCorrupt: line.corrupted });
        const idx = Math.floor(regen.content.length / 2);
        const tampered = `${regen.content.slice(0, idx)}${regen.content[idx] === 'A' ? 'B' : 'A'}${regen.content.slice(idx + 1)}`;
        const tamperedChannels = computeRewardChannels(line, { candidateContent: tampered });
        tamperChecked++;
        if (tamperedChannels.determinismHashMatch !== 0) tamperNotZero.push(line.seed);
      }
    } else {
      // Outside the re-proof slice: skip the regeneration, report null for
      // the determinism channel (excluded from the distribution instead of
      // faking variance).
      channels = computeRewardChannels(line, { skipDeterminism: true });
    }

    const cls = line.corrupted ? 'corrupted' : 'clean';
    for (const name of CHANNEL_NAMES) {
      stats.all[name].add(channels[name]);
      stats[cls][name].add(channels[name]);
    }
  }

  const report = {
    manifest: manifestPath,
    models: total,
    determinism: {
      note: `regenerated-from-seed re-proof on the seed % ${determinismEvery} == 0 slice; tamper probe flips one byte and expects channel 0`,
      checked: determinismChecked,
      failures: determinismFailures.slice(0, 20),
      failureCount: determinismFailures.length,
      tamperProbes: tamperChecked,
      tamperProbesNotZero: tamperNotZero.slice(0, 20),
    },
    channels: Object.fromEntries(CHANNEL_NAMES.map((name) => [name, {
      all: stats.all[name].summary(),
      clean: stats.clean[name].summary(),
      corrupted: stats.corrupted[name].summary(),
    }])),
  };

  const json = JSON.stringify(report, null, 2);
  if (outPath) writeFileSync(outPath, json, 'utf-8');
  process.stdout.write(`${json}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
