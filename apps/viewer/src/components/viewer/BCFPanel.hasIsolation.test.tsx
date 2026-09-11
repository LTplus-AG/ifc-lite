/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `BCFPanel`'s `hasIsolation` computed value, which drives the "Capture will
 * include" hint shown above the active topic's viewpoint list.
 *
 * `isolatedEntities` is meaningfully nullable (`Set<number> | null`): `null`
 * means no isolation channel is active, while a non-null Set — EMPTY
 * included — means one IS active and currently matches nothing. That shape
 * is reachable via `pinboardSlice.ts`'s `addToBasket`/`removeFromBasket`
 * deriving the set incrementally from two `EntityRef`s that alias one
 * globalId (#4509). A `.size > 0` check reads that state as "no isolation"
 * and the hint silently drops the "Isolated objects (others hidden)" line —
 * or, if `hiddenEntities` also happens to be non-empty, shows the wrong
 * "Hidden objects" line instead.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBCFProject, createBCFTopic } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store/index.js';
import { TooltipProvider } from '@/components/ui/tooltip';
import { BCFPanel } from './BCFPanel.js';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderPanel(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <TooltipProvider>
        <BCFPanel onClose={() => {}} />
      </TooltipProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

describe('BCFPanel — hasIsolation with an active-but-empty isolate', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }

    const project = createBCFProject({ name: 'Test' });
    const topic = createBCFTopic({ title: 'A topic', author: 'a@b.com' });
    project.topics.set(topic.guid, topic);

    useViewerStore.setState({
      models: new Map(),
      bcfProject: project,
      activeTopicId: topic.guid,
      bcfError: null,
      bcfLoading: false,
      selectedEntityId: null,
      selectedEntityIds: new Set(),
      // Active isolation, matches nothing — the pinboard alias-collision shape.
      isolatedEntities: new Set<number>(),
      // A real, unrelated hidden entity present at the same time.
      hiddenEntities: new Set<number>([42]),
    });
  });

  it('reports isolation as active, not the unrelated hiddenEntities', () => {
    const container = renderPanel();
    const text = container.textContent ?? '';
    assert.ok(
      text.includes('Isolated objects'),
      'BUG: an active-but-empty isolate was read as "no isolation"; the capture hint ' +
        `either fell silent or claimed "Hidden objects" instead. Got: ${JSON.stringify(text)}`,
    );
    assert.ok(
      !text.includes('Hidden objects'),
      'must not also claim the unrelated hiddenEntities are what capture includes',
    );
  });
});
