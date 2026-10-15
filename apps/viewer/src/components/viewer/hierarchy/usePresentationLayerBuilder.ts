/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import type { buildPresentationLayerTree } from './presentationLayerTree';

export type PresentationLayerBuilder = typeof buildPresentationLayerTree;

// Cache code only. Tree data must always use the current models and edits.
let cachedBuilder: PresentationLayerBuilder | undefined;
let pending: Promise<PresentationLayerBuilder> | undefined;

function loadBuilder(): Promise<PresentationLayerBuilder> {
  if (cachedBuilder) return Promise.resolve(cachedBuilder);
  pending ??= import('./presentationLayerTree').then(
    (module) => { cachedBuilder = module.buildPresentationLayerTree; return cachedBuilder; },
    (error: unknown) => { pending = undefined; throw error; },
  );
  return pending;
}

/** Keep presentation ownership resolution out of the viewer's initial bundle. */
export function usePresentationLayerBuilder(enabled: boolean): {
  builder: PresentationLayerBuilder | undefined;
  ready: boolean;
  error: Error | null;
  retry: () => void;
} {
  const [result, setResult] = useState<{
    builder?: PresentationLayerBuilder;
    error?: Error;
  }>(() => ({ builder: cachedBuilder }));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void loadBuilder().then(
      (builder) => { if (active) setResult({ builder }); },
      (error: unknown) => {
        if (active) setResult({ error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
    return () => { active = false; };
  }, [enabled, attempt]);
  const builder = cachedBuilder ?? result.builder;
  return {
    builder,
    ready: !enabled || !!builder,
    error: enabled && !builder ? result.error ?? null : null,
    retry: () => { setResult({}); setAttempt((value) => value + 1); },
  };
}
