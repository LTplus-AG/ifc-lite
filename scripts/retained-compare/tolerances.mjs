// SPDX-License-Identifier: MPL-2.0
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Top-level keys are indivisible preregistrations, including nested objects. */
export function loadTolerances(directory = 'tests/fixtures/cli-retained') {
  const fragments = join(directory, 'tolerances.d');
  let names;
  try { names = readdirSync(fragments).filter((name) => name.endsWith('.json')).sort(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    names = [];
  }
  const merged = {}, owners = new Map();
  for (const file of [join(directory, 'tolerances.json'), ...names.map((name) => join(fragments, name))]) {
    let data;
    try { data = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { throw new Error(`${file}: ${error.message}`); }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file}: expected a tolerance object`);
    for (const [key, value] of Object.entries(data)) {
      if (owners.has(key)) throw new Error(`Duplicate tolerance ${key}: ${owners.get(key)} and ${file}; never redefine existing keys`);
      owners.set(key, file);
      Object.defineProperty(merged, key, { value, enumerable: true });
    }
  }
  return merged;
}
