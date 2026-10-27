// SPDX-License-Identifier: MPL-2.0
export function tsv(text) {
  const [header, ...lines] = text.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  if (!header) throw new Error('Empty comparison manifest');
  const keys = header.split('\t');
  return lines.map(line => Object.fromEntries(line.split('\t').map((value, i) => [keys[i], value])));
}
const key = p => `${p.model}#${p.id}`;
export function compare(native, actual, blessed, tolerance) {
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
      if (!Number.isFinite(nv) || !Number.isFinite(av) || !Number.isFinite(relative) || relative > tolerance) violations.push(`${id}: volume relative ${relative}`);
      maxVolumeRelative = Math.max(maxVolumeRelative, relative);
    }
  }
  return { products: observed.size, maxVolumeRelative, violations };
}
