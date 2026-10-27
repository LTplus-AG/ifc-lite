// SPDX-License-Identifier: MPL-2.0
import { readFile, readdir } from 'node:fs/promises';
import { tsv } from './metrics.mjs';
export async function coverageRows(base = 'tests/manifests/cli-retained-coverage') {
  let entries;
  try { entries = await readdir(`${base}.d`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
  const files = [`${base}.tsv`, ...entries.filter(p => p.endsWith('.tsv')).sort().map(p => `${base}.d/${p}`)];
  const owners = new Map(), keys = new Set(), rows = [];
  for (const path of files) {
    for (const row of tsv(await readFile(path, 'utf8'))) {
      if (owners.has(row.model) && owners.get(row.model) !== path) throw new Error(`Model spans coverage files: ${row.model}`);
      const key = `${row.model}\t${row.id}`;
      if (keys.has(key)) throw new Error(`Duplicate coverage row: ${key}`);
      keys.add(key); owners.set(row.model, path); rows.push(row);
    }
  }
  return rows;
}
