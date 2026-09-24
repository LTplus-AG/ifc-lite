/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A stale-deployment failure that reaches `useIfcLoader.loadFile`'s catch must
 * raise the "reload to continue" notice and leave the generic load error unset
 * (#5609). Driven through the real `loadFile`: the file's first read rejects
 * with the exact error geometry-parallel.ts builds for a worker script that
 * failed to load, so removing the loader's routing turns this red.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { StaleDeploymentNotice } from '@/components/StaleDeploymentNotice';
import { __resetStaleDeploymentForTests } from '@/lib/stale-deployment';
import { useIfcLoader } from './useIfcLoader.js';

const NOTICE = 'A new version of the viewer is available — reload to continue.';

/** An IFC file whose first read fails with `error`. */
function failingFile(error: Error): File {
  const file = new File(['ISO-10303-21;'], 'tower.ifc');
  file.slice = () => {
    const head = new Blob([]);
    head.arrayBuffer = () => Promise.reject(error);
    return head;
  };
  return file;
}

let hookApi: ReturnType<typeof useIfcLoader> | null = null;
function Probe(): null {
  hookApi = useIfcLoader();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  hookApi = null;
  __resetStaleDeploymentForTests();
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<><Probe /><StaleDeploymentNotice /></>));
  assert.ok(hookApi);
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
});

describe('useIfcLoader stale-deployment failure (#5609)', () => {
  it('shows the reload notice, not a generic load error', async () => {
    const stale = new Error('Geometry worker failed: worker script failed to load (possibly a stale deployment)');
    await act(async () => hookApi!.loadFile(failingFile(stale), { kind: 'primary' }));

    assert.equal(useViewerStore.getState().error, null, 'no generic load error');
    assert.ok(document.body.textContent?.includes(NOTICE), document.body.textContent ?? '');
  });

  it('keeps the generic load error for any other failure', async () => {
    const crash = new Error('Geometry worker failed: worker terminated unexpectedly');
    await act(async () => hookApi!.loadFile(failingFile(crash), { kind: 'primary' }));

    assert.match(useViewerStore.getState().error ?? '', /tower\.ifc/);
    assert.ok(!document.body.textContent?.includes(NOTICE));
  });
});
