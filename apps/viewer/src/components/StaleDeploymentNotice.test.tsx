/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A geometry worker whose script 404s after a deploy must leave the user a
 * "reload to continue" notice, not a generic load error (#5609). PostHog's
 * most frequent client exception was exactly this failure reaching the user
 * raw once the one automatic reload had already been spent. The loader's own
 * catch sites are driven in ../hooks/useIfcLoader.staleDeployment.test.tsx.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { WASM_ASSET_UNAVAILABLE_EVENT } from '@ifc-lite/geometry';
import { cleanup, render } from '@/test/render.js';
import { installWasmVersionSkewRecovery, __resetWasmVersionSkewForTests } from '@/lib/wasm-version-skew';

// Guarded dynamic imports (revert-oracle, same pattern as
// ViewerLayout.i18n.test.tsx): a static import of a module this change adds
// would fail the whole FILE's load once production is reverted (no subtest
// runs, INCONCLUSIVE). A missing module instead becomes a no-op notice, so the
// assertions below run and fail on their own merits.
type StaleDeploymentModule = typeof import('@/lib/stale-deployment');
type NoticeModule = typeof import('@/components/StaleDeploymentNotice');
let resetStaleDeployment: StaleDeploymentModule['__resetStaleDeploymentForTests'] = () => {};
let StaleDeploymentNotice: NoticeModule['StaleDeploymentNotice'] = () => null;
try {
  ({ __resetStaleDeploymentForTests: resetStaleDeployment } = await import('@/lib/stale-deployment'));
  ({ StaleDeploymentNotice } = await import('@/components/StaleDeploymentNotice'));
} catch {
  // Not re-printed: the loader's error text is exactly what the oracle reads
  // as "never loaded", which would hide the red assertions below.
  console.warn('[test] stale-deployment modules unavailable; the notice assertions will fail');
}

const NOTICE = 'A new version of the viewer is available — reload to continue.';

function bodyText(): string {
  return document.body.textContent ?? '';
}

/** The worker-script skew event exactly as `notifyIfWorkerScriptUnavailable` dispatches it. */
function dispatchWorkerScriptSkew(): void {
  window.dispatchEvent(
    new CustomEvent(WASM_ASSET_UNAVAILABLE_EVENT, {
      detail: { message: 'worker script failed to load', kind: 'worker-script' },
    }),
  );
}

beforeEach(() => {
  resetStaleDeployment();
  __resetWasmVersionSkewForTests();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('stale geometry worker (#5609)', () => {
  it('shows the reload notice once the automatic reload is already spent', () => {
    // A reload ran moments ago in this tab and did not fix it: the debounce
    // refuses a second one, so the user has to be told what to do.
    sessionStorage.setItem('ifclite:wasm-skew-reload-ts', String(Date.now()));
    installWasmVersionSkewRecovery();
    render(<StaleDeploymentNotice />);
    assert.ok(!bodyText().includes(NOTICE));

    act(() => dispatchWorkerScriptSkew());

    const alert = document.querySelector('[role="alert"]');
    assert.ok(alert, 'a persistent alert is on screen');
    assert.ok(alert.textContent?.includes(NOTICE), alert.textContent ?? '');
    assert.ok(alert.querySelector('button')?.textContent?.includes('Reload'));
  });
});
