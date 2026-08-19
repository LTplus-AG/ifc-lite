/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression test for the "crashed widget masks every later one" defect
 * (#2765): `WidgetErrorBoundary` never cleared `state.error`, and its only
 * caller (`ExtensionDockHost`'s `DockBody`) reused the same React instance
 * across tab switches (no `key`). Once any widget threw, every
 * subsequently-viewed widget rendered the SAME stale error instead of its
 * own content.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WidgetErrorBoundary } from './WidgetErrorBoundary.js';

function ThrowingWidget(): never {
  throw new Error('widget A blew up');
}

function HealthyWidget() {
  return <div data-testid="healthy">widget B content</div>;
}

describe('WidgetErrorBoundary', () => {
  it('characterizes the defect: without a key, the same instance keeps showing a stale crash (#2765)', async () => {
    // This is the exact bug this suite guards against, reproduced directly
    // against the boundary: `ExtensionDockHost` used to render
    // `<WidgetErrorBoundary>` with no `key`, so switching the active dock
    // tab reused the same React instance. `getDerivedStateFromError` sets
    // `state.error` and nothing ever clears it, so a healthy widget B
    // rendered underneath the still-standing fallback for crashed widget
    // A. This test intentionally omits the `key` the real call site now
    // applies, to document why that key is load-bearing rather than
    // decorative — it is expected to keep "passing" (i.e. keep
    // demonstrating the stale banner) forever, since the component itself
    // deliberately never self-heals (see its doc comment).
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | undefined;

    try {
      await act(async () => {
        root = createRoot(container);
        root.render(
          <WidgetErrorBoundary label="ext-a/widget-a">
            <ThrowingWidget />
          </WidgetErrorBoundary>,
        );
      });
      assert.match(container.innerHTML, /ext-a\/widget-a crashed while rendering/);

      // Same instance (no key change) now asked to render a different,
      // healthy widget — mirrors an unkeyed `DockBody`/`WidgetErrorBoundary`
      // on tab switch.
      await act(async () => {
        root!.render(
          <WidgetErrorBoundary label="ext-b/widget-b">
            <HealthyWidget />
          </WidgetErrorBoundary>,
        );
      });

      const html = container.innerHTML;
      assert.doesNotMatch(
        html,
        /widget B content/,
        'documents the defect: B never renders while the stale instance holds an error',
      );
      assert.match(
        html,
        /widget A blew up/,
        'documents the defect: A\'s stale error text is still shown for B\'s slot',
      );
    } finally {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    }
  });

  it('does not leak a stale error onto the next widget after a key-based remount', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | undefined;

    try {
      await act(async () => {
        root = createRoot(container);
        root.render(
          <WidgetErrorBoundary key="ext-a/widget-a" label="ext-a/widget-a">
            <ThrowingWidget />
          </WidgetErrorBoundary>,
        );
      });

      const crashedHtml = container.innerHTML;
      assert.match(crashedHtml, /ext-a\/widget-a crashed while rendering/);
      assert.match(crashedHtml, /widget A blew up/);

      // Switch to a different, healthy widget. In the real call site this
      // is a `key` change (our chosen fix), which forces React to discard
      // the old boundary instance and mount a fresh one.
      await act(async () => {
        root!.render(
          <WidgetErrorBoundary key="ext-b/widget-b" label="ext-b/widget-b">
            <HealthyWidget />
          </WidgetErrorBoundary>,
        );
      });

      const healthyHtml = container.innerHTML;
      assert.match(healthyHtml, /widget B content/, 'healthy widget B must render');
      assert.doesNotMatch(
        healthyHtml,
        /crashed while rendering/,
        'no stale crash banner should survive the switch',
      );
      assert.doesNotMatch(
        healthyHtml,
        /widget A blew up/,
        'widget A\'s error text must not leak onto widget B',
      );
    } finally {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    }
  });

  it('still catches a genuine render crash', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | undefined;

    try {
      await act(async () => {
        root = createRoot(container);
        root.render(
          <WidgetErrorBoundary key="ext-c/widget-c" label="ext-c/widget-c">
            <ThrowingWidget />
          </WidgetErrorBoundary>,
        );
      });

      const html = container.innerHTML;
      assert.match(html, /ext-c\/widget-c crashed while rendering/);
      assert.match(html, /widget A blew up/);
    } finally {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    }
  });
});
