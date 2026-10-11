/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { CapturedEntityScope } from '@ifc-lite/rules';
import type { LensDataProvider } from './types.js';

/** Scope the native engine's iteration itself, including auto-color's absent
 * buckets and manual Lens context, rather than only the rule match sets. */
export function resolveLensScope(provider: LensDataProvider, scope?: CapturedEntityScope): ReadonlySet<number> | undefined {
  if (!scope) return undefined;
  if (!provider.resolveCapturedScope) throw new Error('This provider cannot resolve the captured file and entity scope. Nothing was run.');
  return provider.resolveCapturedScope(scope);
}
