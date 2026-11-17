/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Process-local provenance, retained only while the loaded model is alive. */
interface SourceFileIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

// Keep native filesystem metadata out of the public/browser model surface.
const sources = new WeakMap<object, SourceFileIdentity>();

export function rememberLoadedSource(model: object, source: SourceFileIdentity): void {
  sources.set(model, Object.freeze({ ...source }));
}

export function getLoadedSource(model: object): SourceFileIdentity | undefined {
  return sources.get(model);
}
