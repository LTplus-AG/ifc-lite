/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, Component, Suspense, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { lazyChunk } from './lazy-chunk.js';
import { __resetStaleDeploymentForTests, isStaleDeploymentReported } from './stale-deployment.js';

// The exact rejection Gecko produced for #10684 on the self-hosted deployment.
const GECKO_CHUNK_FAILURE =
  'error loading dynamically imported module: https://viewer.example/assets/dpl_77Fn9eEaTurTjv77yUJRQjdHWgyX/RhinoExportDialog-D_4cLIIM.js';

const roots: Array<{ root: Root; container: HTMLElement }> = [];

/** Mount and let the lazy import settle, rejected or not. */
async function mount(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  // React reports an uncaught render error here instead of throwing it.
  const root = createRoot(container, { onUncaughtError: () => {} });
  roots.push({ root, container });
  await act(async () => { root.render(node); });
  await act(async () => {});
  return container;
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() { return this.state.error ? <p>caught: {this.state.error.message}</p> : this.props.children; }
}

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
  __resetStaleDeploymentForTests();
});

describe('lazyChunk (#10684)', () => {
  it('keeps the rest of the app mounted when a chunk fails to load with no boundary above it', async () => {
    const Dialog = lazyChunk<() => ReactNode>(() => Promise.reject(new TypeError(GECKO_CHUNK_FAILURE)));
    const container = await mount(
      <div>
        <span>ribbon</span>
        <Suspense fallback={<button type="button">Rhino</button>}>
          <Dialog />
        </Suspense>
      </div>,
    );
    assert.equal(container.textContent, 'ribbon', 'the app survives and the failed slot renders nothing');
    assert.equal(isStaleDeploymentReported(), true, 'the reload notice is raised');
  });

  it('still rejects a module that loaded but threw, so a real bug reaches its boundary', async () => {
    const Panel = lazyChunk<() => ReactNode>(() => Promise.reject(new Error('Cannot read properties of undefined')));
    const container = await mount(
      <Boundary>
        <Suspense fallback={null}>
          <Panel />
        </Suspense>
      </Boundary>,
    );
    assert.equal(container.textContent, 'caught: Cannot read properties of undefined');
    assert.equal(isStaleDeploymentReported(), false, 'a crash is not reported as a stale deployment');
  });

  it('renders the component when the chunk loads', async () => {
    const Panel = lazyChunk(() => Promise.resolve({ default: ({ name }: { name: string }) => <em>{name}</em> }));
    const container = await mount(<Suspense fallback={null}><Panel name="loaded" /></Suspense>);
    assert.equal(container.textContent, 'loaded');
    assert.equal(isStaleDeploymentReported(), false);
  });
});
