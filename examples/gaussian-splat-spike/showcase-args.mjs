/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567: CLI argument checks shared by the showcase recorders and finishers.
// Values are validated before path resolution: resolve('') would silently
// become the current directory and turn a missing argument into a wrong one.
import { isAbsolute, resolve } from 'node:path';

/** Throws, naming every missing option, when a required value is absent or empty. */
export function requireOptions(values, names, usage) {
  const missing = names.filter(name => typeof values[name] !== 'string' || values[name].trim() === '');
  if (missing.length) throw new Error(`missing ${missing.map(name => `--${name}`).join(', ')}${usage ? `; usage: ${usage}` : ''}`);
}

/** The fixture directory from --assets or SPLAT_SPIKE_ASSETS, never an implicit fallback. */
export function assetsDirectory(argument, env = process.env) {
  const raw = typeof argument === 'string' && argument.trim() ? argument : env.SPLAT_SPIKE_ASSETS;
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('missing --assets (or SPLAT_SPIKE_ASSETS): the directory holding the catalogued capture');
  return resolve(raw);
}

/** An output directory must be given as an absolute path. */
export function absoluteOutput(argument) {
  if (typeof argument !== 'string' || !isAbsolute(argument)) throw new Error(`--out must be an absolute directory, got ${JSON.stringify(argument)}`);
  return argument;
}
