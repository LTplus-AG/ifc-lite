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
import { __resetStaleDeploymentForTests } from '@/lib/stale-deployment';
import { installWasmVersionSkewRecovery, __resetWasmVersionSkewForTests } from '@/lib/wasm-version-skew';
import { StaleDeploymentNotice } from './StaleDeploymentNotice';

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
});
