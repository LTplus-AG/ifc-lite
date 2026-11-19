/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { registerHooks } from 'node:module';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary';
import { StaleDeploymentNotice } from '@/components/StaleDeploymentNotice';
import { RhinoExportCommand } from '@/components/viewer/RhinoExportCommand';
import { __resetStaleDeploymentForTests } from './stale-deployment.js';

it('keeps the ribbon and reload action available after the Rhino dynamic import fails (#10684)', async () => {
  // Represent the page the user gets after the one automatic reload.
  sessionStorage.setItem('ifclite:chunk-skew-reload-ts', String(Date.now()));
  let attempted = false;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './RhinoExportDialog' && context.parentURL?.endsWith('/RhinoExportCommand.tsx')) {
        attempted = true;
        throw new TypeError('error loading dynamically imported module: https://viewer.example/assets/RhinoExportDialog.js');
      }
      return nextResolve(specifier, context);
    },
  });
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

    assert.ok(attempted, 'the production dynamic import was attempted');
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
    hooks.deregister();
    sessionStorage.removeItem('ifclite:chunk-skew-reload-ts');
    __resetStaleDeploymentForTests();
  }
});
