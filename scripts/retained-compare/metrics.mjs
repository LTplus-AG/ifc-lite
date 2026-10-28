// SPDX-License-Identifier: MPL-2.0
export function tsv(text) {
  const [header, ...lines] = text.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  if (!header) throw new Error('Empty comparison manifest');
  const keys = header.split('\t');
  return lines.map(line => Object.fromEntries(line.split('\t').map((value, i) => [keys[i], value])));
}
const key = p => `${p.model}#${p.id}`;
// The runtime's conservative curved bit also marks planar Boolean results.
// Only the independently decoded clip source can qualify this scoped gate.
function volumeTolerance(row, base, clippedCurved) {
  if (clippedCurved === undefined || !row.src_oracle) return base;
  const checks = JSON.parse(row.src_oracle);
  if (!Array.isArray(checks)) throw new Error('Expected source-oracle result array');
  const qualified = checks.some(r => r.family === 'clipSectionVolumeRelative' &&
    r.sourceCurved === true && r.gated === true && r.pass === true) &&
    checks.every(r => !r.gated || (r.pass === true && Number.isFinite(r.value) &&
      Number.isFinite(r.limit) && r.value <= r.limit));
  return qualified ? clippedCurved : base;
}
export function compare(native, actual, blessed, tolerance, clippedCurvedTolerance) {
  if (clippedCurvedTolerance !== undefined && (!Number.isFinite(clippedCurvedTolerance) ||
      clippedCurvedTolerance < tolerance || clippedCurvedTolerance > 1e-7)) {
    throw new Error('Invalid clipped-curved native/wasm tolerance');
  }
  const scopedVolumeRows = [];
  const violations = [];
  const index = rows => {
    const map = new Map();
    for (const row of rows) {
      if (map.has(key(row))) violations.push(`duplicate ${key(row)}`);
      map.set(key(row), row);
    }
    return map;
  };
  const expected = index(native.filter(p => p.status !== 'exact_only_type_product'));
  const observed = index(actual), manifest = index(blessed);
  let maxVolumeRelative = 0;
  for (const id of new Set([...expected.keys(), ...observed.keys(), ...manifest.keys()])) {
    const n = expected.get(id), a = observed.get(id), b = manifest.get(id);
    if (!n || !a || !b) { violations.push(`${id}: product universe mismatch`); continue; }
    if (a.status !== n.status || a.status !== b.status || (a.code ?? '') !== n.code || n.code !== b.code) {
      violations.push(`${id}: status/code mismatch`);
    }
    if (a.code === 'contract_breach') violations.push(`${id}: contract_breach`);
    if (a.status === 'published') {
      const nv = Number(n.volume_m3), av = a.volumeM3;
      const relative = nv === 0 ? (av === 0 ? 0 : Infinity) : Math.abs(av - nv) / Math.abs(nv);
      const limit = volumeTolerance(n, tolerance, clippedCurvedTolerance);
      if (limit !== tolerance) scopedVolumeRows.push({ product: id, limit, relative });
      if (!Number.isFinite(nv) || !Number.isFinite(av) || !Number.isFinite(relative) || relative > limit) violations.push(`${id}: volume relative ${relative}`);
      maxVolumeRelative = Math.max(maxVolumeRelative, relative);
    }
  }
  return { products: observed.size, maxVolumeRelative, scopedVolumeRows, violations };
}
