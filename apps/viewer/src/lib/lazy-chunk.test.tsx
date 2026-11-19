/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { register } from 'node:module';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { waitFor } from '@/test/render.js';
import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary';
import { StaleDeploymentNotice } from '@/components/StaleDeploymentNotice';
import { RhinoExportCommand } from '@/components/viewer/RhinoExportCommand';
import { handlePreloadError } from './chunk-version-skew.js';
import { __resetStaleDeploymentForTests, isStaleDeploymentReported } from './stale-deployment.js';

it('keeps the ribbon and reload action available after the Rhino dynamic import fails (#10684)', async () => {
  // Represent the page the user gets after the one automatic reload.
  sessionStorage.setItem('ifclite:chunk-skew-reload-ts', String(Date.now()));
  // The Node test runner isolates this file in its own process. Only this
  // command's import is substituted, with the failure Gecko would send.
  const loader = `
    export function resolve(specifier, context, nextResolve) {
      if (specifier === './RhinoExportDialog' && context.parentURL?.endsWith('/RhinoExportCommand.tsx')) {
        throw new TypeError('error loading dynamically imported module: https://viewer.example/assets/RhinoExportDialog.js');
      }
      return nextResolve(specifier, context);
    }
  `;
  register(`data:text/javascript,${encodeURIComponent(loader)}`);
  const container = document.createElement('div');
  document.body.append(container);
  const uncaught: unknown[] = [];
  const root = createRoot(container, { onUncaughtError: (error) => uncaught.push(error) });
  try {
    await act(async () => root.render(
      <>
        <button>Working ribbon action</button>
        <RhinoExportCommand surface="ribbon" />
        <ChunkErrorBoundary label="Layers panel">
          <RhinoExportCommand surface="ribbon" />
        </ChunkErrorBoundary>
        <StaleDeploymentNotice />
      </>,
    ));

    await waitFor(
      () => uncaught.length > 0 || !!container.textContent?.includes('Layers panel could not be loaded'),
      'the lazy rejection reaches React',
    );

    assert.equal(uncaught.length, 0, 'the failed import must not unmount the viewer');
    assert.match(container.textContent ?? '', /Working ribbon action/);
    assert.match(container.textContent ?? '', /Layers panel could not be loaded/);
    const notice = Array.from(container.querySelectorAll('[role="alert"]'))
      .find((alert) => alert.textContent?.includes('A new version of the viewer is available'));
    assert.ok(notice, 'the shared reload notice is visible');
    assert.equal(notice?.querySelector('button')?.textContent, 'Reload');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.removeItem('ifclite:chunk-skew-reload-ts');
    __resetStaleDeploymentForTests();
  }
});

it('offers a manual reload when the automatic navigation leaves the page open (#10684)', ({ mock }) => {
  const reload = mock.method(window.location, 'reload', () => {});
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const failure = Object.assign(new Event('vite:preloadError', { cancelable: true }), {
      payload: new TypeError('Importing a module script failed.'),
    });
    assert.equal(handlePreloadError(failure), 'reloaded');
    assert.equal(reload.mock.callCount(), 1);
    assert.equal(isStaleDeploymentReported(), false, 'wait while the navigation can still commit');

    mock.timers.tick(10_000);

    assert.equal(reload.mock.callCount(), 1, 'the timer does not spend another automatic attempt');
    assert.equal(isStaleDeploymentReported(), true, 'a tab that stayed open gets the manual recovery');
  } finally {
    sessionStorage.removeItem('ifclite:chunk-skew-reload-ts');
    __resetStaleDeploymentForTests();
  }
});
