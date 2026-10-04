/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isDeepStrictEqual } from 'node:util';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const epsilon = value => 4 * Number.EPSILON * Math.max(1, Math.abs(value));
const percentage = (part, total) => part / Math.max(1, total) * 100;

// A fixed decimal display certifies a half-quantum interval, not the original
// float. Closed tie endpoints admit either adjacent decimal at the binary
// rounding boundary; the only slack is four scaled f64 representation ULPs.
function displayMatches(display, places, actual) {
  const scaled = actual * 10 ** places;
  return Number.isFinite(actual) && actual >= 0
    && Math.abs(Number(display) * 10 ** places - scaled) <= 0.5 + epsilon(scaled);
}
function fixedDecimal(value, places) {
  const scaled = value * 10 ** places;
  return Number.isFinite(value) && value >= 0
    && Math.abs(scaled - Math.round(scaled)) <= epsilon(scaled);
}
function decimalRange(value, places) {
  const half = 0.5 / 10 ** places, slack = epsilon(value * 10 ** places) / 10 ** places;
  return [Math.max(0, value - half - slack), value + half + slack];
}

/** The pinned, single-fixture, non-cold/non-census print_human contract. */
export function probeSummary(text, result, fixture) {
  const receipt = { status: 'pending', parsedLines: 0, diagnostics: {},
    floatScope: 'fixed decimal quantization intervals; no unrounded float claim' };
  let cursor = 0;
  const refuse = message => { throw new Error(`canonical probe summary refused: ${message}`); };
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 64 * 1024
      || !text.endsWith('\n') || text.includes('\r')) refuse('bounded complete UTF8 lines required');
    const lines = text.split('\n');
    if (lines.length > 24 || lines.some(line => Buffer.byteLength(line, 'utf8') > 4096)) refuse('line bounds');
    if (!integer(fixture.bytes) || fixture.bytes < 1 || fixture.file !== result.path) refuse('frozen fixture binding');
    for (const key of ['entities', 'meshes', 'vertices', 'triangles', 'parseMs', 'entityScanMs', 'lookupMs',
      'preprocessMs', 'geometryMs', 'facetedBrepMs', 'totalMs', 'pointCacheHits', 'pointCacheMisses',
      'csgFailures', 'degenerateDropped']) if (!integer(result[key])) refuse(`integer ${key}`);
    if (result.totalMs < 1 || !fixedDecimal(result.fileMb, 3)
      || !displayMatches(result.fileMb, 3, fixture.bytes / 1048576)
      || !fixedDecimal(result.indexBuildMs, 2)) refuse('file/index decimal provenance');
    const take = pattern => {
      const line = lines[cursor++], match = typeof pattern === 'string'
        ? line === pattern ? [line] : null : pattern.exec(line ?? '');
      if (!match) refuse(`line ${cursor} does not match declared schema`);
      receipt.parsedLines = cursor; return match;
    };
    const count = (token, expected) => {
      const value = Number(token);
      if (!integer(value) || String(value) !== token || value !== expected) refuse('integer value mismatch');
      return value;
    };
    const equalList = (raw, values, kind) => {
      const part = kind === 'integer' ? '(?:0|[1-9]\\d*)' : '(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:e[+-]?\\d+)?';
      if (kind === 'hash') {
        if (raw !== `[${values.map(value => JSON.stringify(value)).join(', ')}]`) refuse('FNV list mismatch');
      } else if (!new RegExp(`^\\[${part}(?:, ${part}){4}\\]$`).test(raw)
        || !isDeepStrictEqual(JSON.parse(raw), values)) refuse(`${kind} iteration list mismatch`);
    };
    const phase = (pattern, key) => {
      const match = take(pattern); count(match[1], result[key]);
      if (!displayMatches(match[2], 1, percentage(result[key], result.totalMs))) refuse(`${key} percentage`);
    };
    take('perf_probe: 1 fixture(s), best-of-5'); take(''); take(`=== ${fixture.file} ===`);
    const census = take(/^  (\d+\.\d) MB \| (\d+) entities \| (\d+) meshes \| (\d+) verts \| (\d+) tris \| (\d+\.\d{2}) Mtris\/s \(geom\)$/);
    if (!displayMatches(census[1], 1, fixture.bytes / 1048576)) refuse('file size display');
    ['entities', 'meshes', 'vertices', 'triangles'].forEach((key, index) => count(census[index + 2], result[key]));
    if (!displayMatches(census[6], 2, result.geometryMs > 0 ? result.triangles / result.geometryMs / 1000 : 0)) refuse('throughput display');
    const best = take(/^  best total (\d+) ms  \(runs: (\[.*\]) ms\)$/);
    count(best[1], result.totalMs); equalList(best[2], result.allTotalsMs, 'integer');
    equalList(take(/^  ordered mesh FNV-1a64 \(per run\): (\[.*\])$/)[1], result.meshFingerprintsFnv1a64, 'hash');
    take('  phase                    ms        % total');
    equalList(take(/^  full pipeline wall: (\[.*\]) ms \(includes final metadata\)$/)[1], result.allWallMs, 'float');
    phase(/^  parse \(pre-geometry\) +([0-9]+) +([0-9]+\.[0-9])%$/, 'parseMs');
    const index = take(/^    - index-scan alone +([0-9]+\.[0-9]) +([0-9]+\.[0-9])%$/);
    const jsonRange = decimalRange(result.indexBuildMs, 2), humanRange = decimalRange(Number(index[1]), 1);
    const low = Math.max(jsonRange[0], humanRange[0]), high = Math.min(jsonRange[1], humanRange[1]);
    // pct(index_ms as u64, total) truncates the underlying scan float. At a
    // JSON rounding boundary its integer may differ from trunc(rounded JSON).
    if (low > high || ![Math.floor(low), Math.floor(high)].some(value =>
      displayMatches(index[2], 1, percentage(value, result.totalMs)))) refuse('index display/truncated percentage');
    receipt.indexQuantizationRange = [low, high];
    phase(/^    - entity_scan +([0-9]+) +([0-9]+\.[0-9])%$/, 'entityScanMs');
    phase(/^    - lookup\/styles +([0-9]+) +([0-9]+\.[0-9])%$/, 'lookupMs');
    phase(/^    - preprocess +([0-9]+) +([0-9]+\.[0-9])%$/, 'preprocessMs');
    phase(/^  geometry +([0-9]+) +([0-9]+\.[0-9])%$/, 'geometryMs');
    if (result.facetedBrepMs > 0) phase(/^    - faceted-brep +([0-9]+) +([0-9]+\.[0-9])%   \(observability build\)$/, 'facetedBrepMs');
    const cacheRefs = result.pointCacheHits + result.pointCacheMisses;
    if (!integer(cacheRefs)) refuse('cache sum overflow');
    if (cacheRefs > 0) {
      const cache = take(/^  brep point-cache +(\d+) hits \/ (\d+) misses \(([0-9]+\.[0-9])% memoized\)$/);
      count(cache[1], result.pointCacheHits); count(cache[2], result.pointCacheMisses);
      if (!displayMatches(cache[3], 1, percentage(result.pointCacheHits, cacheRefs))) refuse('cache percentage');
    }
    receipt.diagnostics.csgFailures = result.csgFailures;
    receipt.diagnostics.productsWithFailures = 0;
    if (result.csgFailures > 0) {
      const failures = take(/^  csg failures +(\d+) across (\d+) products$/); count(failures[1], result.csgFailures);
      const products = Number(failures[2]);
      // record_csg_failures rejects empty vectors; each attributed nonzero key
      // counted by count_attributed_products contributes >=1 total record.
      // Unattributed bucket zero can make the product count zero.
      if (!integer(products) || String(products) !== failures[2] || products > result.csgFailures) refuse('attributed product bound');
      receipt.diagnostics.productsWithFailures = products;
    }
    receipt.diagnostics.degenerateDropped = result.degenerateDropped;
    if (result.degenerateDropped > 0) count(take(/^  degenerate dropped +(\d+)$/)[1], result.degenerateDropped);
    take(''); if (cursor !== lines.length) refuse('extra diagnostics');
    receipt.status = 'complete-canonical-summary'; return receipt;
  } catch (error) {
    receipt.status = 'refused'; receipt.reason = String(error); error.summaryReceipt = receipt; throw error;
  }
}

/** Failure attribution is separate from timing/cache-hit statistics. */
export function requireSummaryDiagnostics(left, right, witness) {
  for (const row of [left, right, ...(witness ? [witness] : [])]) {
    if (row?.status !== 'complete-canonical-summary'
      || !isDeepStrictEqual(left.diagnostics, row.diagnostics)) throw new Error('canonical native diagnostic attribution differs');
  }
}
