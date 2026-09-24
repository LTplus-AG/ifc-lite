/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A geometry worker whose script 404s after a deploy must leave the user a
 * "reload to continue" notice, not a generic load error (#5609). PostHog's
 * most frequent client exception was exactly this failure reaching the user
 * raw once the one automatic reload had already been spent.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { WASM_ASSET_UNAVAILABLE_EVENT } from '@ifc-lite/geometry';
import { cleanup, render } from '@/test/render.js';
import { formatLoadError } from '@/lib/load-error-message';
import { __resetStaleDeploymentForTests, surfaceStaleDeployment } from '@/lib/stale-deployment';
import { installWasmVersionSkewRecovery, __resetWasmVersionSkewForTests } from '@/lib/wasm-version-skew';
import { StaleDeploymentNotice } from './StaleDeploymentNotice';

// The exact error geometry-parallel.ts builds for a worker that never spoke.
const STALE_WORKER = new Error(
  'Geometry worker failed: worker script failed to load (possibly a stale deployment)',
);
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
  __resetStaleDeploymentForTests();
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

  it('routes the loader failure to the notice instead of the generic load error', () => {
    render(<StaleDeploymentNotice />);
    const generic = formatLoadError(STALE_WORKER, 'tower.ifc', 'geometry_processing');
    let shownError: string | null = null;

    // The useIfcLoader catch sites: `if (!surfaceStaleDeployment(err)) setError(...)`.
    act(() => {
      if (!surfaceStaleDeployment(STALE_WORKER)) shownError = generic;
    });

    assert.equal(shownError, null, 'no generic load error for a stale deployment');
    assert.ok(bodyText().includes(NOTICE));
  });

  it('leaves a worker that crashed after it ran to the generic load error', () => {
    render(<StaleDeploymentNotice />);
    const crash = new Error('Geometry worker failed: worker terminated unexpectedly');
    let handled = true;
    act(() => {
      handled = surfaceStaleDeployment(crash);
    });
    assert.equal(handled, false);
    assert.ok(!bodyText().includes(NOTICE));
  });
});
