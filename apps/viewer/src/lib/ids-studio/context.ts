/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The schema tables IDS Studio grounds every edit in: the gate context (entity,
 * pset, data type tables per IFC version) and the lint context built on the
 * same tables. Loaded once per page, on first use of the Studio.
 */

import { createGateContext, createLintContext, type GateContext, type LintContext } from '@ifc-lite/ids-authoring';

export interface StudioContexts {
  gate: GateContext;
  lint: LintContext;
}

let shared: Promise<StudioContexts> | null = null;

export function loadStudioContexts(): Promise<StudioContexts> {
  shared ??= (async () => {
    const gate = await createGateContext();
    return { gate, lint: await createLintContext({ gate }) };
  })();
  // A failed load must be retryable rather than cached forever.
  shared.catch((error: unknown) => {
    console.warn('[ids-studio] schema tables failed to load', error);
    shared = null;
  });
  return shared;
}
