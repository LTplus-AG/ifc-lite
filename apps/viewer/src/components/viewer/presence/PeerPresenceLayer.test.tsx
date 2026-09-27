/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `PeerPresenceLayer` on the shared scene-overlay kernel (#5511, charter
 * #5478): a peer's cursor is a `Pin` registered on the shared
 * `SceneProjector`, not a bespoke `requestAnimationFrame` poll.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CollabSession } from '@ifc-lite/collab';
import { cleanup } from '@/test/render.js';
import { renderScene } from '@/components/viewport-ui/scene/test/scene-test-support';
import { useViewerStore } from '@/store';
import { PeerPresenceLayer } from './PeerPresenceLayer';

const FAKE_SESSION = {} as unknown as CollabSession;

afterEach(() => {
  cleanup();
  useViewerStore.setState({ collabSession: null, collabPeers: [] });
});

describe('PeerPresenceLayer', () => {
  it('projects a peer cursor as a Pin in the peer color, hidden until the shared projector ticks', () => {
    useViewerStore.setState({
      collabSession: FAKE_SESSION,
      collabPeers: [
        {
          clientId: 42,
          user: { name: 'Anna', color: '#ff9900' },
          cursor3d: { x: 3, y: 4, z: 0 },
          lastUpdate: Date.now(),
        },
      ] as never,
    });
    const { container, flush } = renderScene(<PeerPresenceLayer />);
    const pin = container.querySelector('[data-peer-cursor-id="42"]') as SVGGElement;
    assert.ok(pin, 'peer cursor Pin registered');
    assert.equal(pin.style.display, 'none');
    flush();
    assert.equal(pin.style.display, '');
    assert.equal(pin.style.transform, 'translate(3px, 4px)');
    const path = pin.querySelector('path') as SVGPathElement;
    assert.equal(path.style.fill, '#ff9900');
    // Mutation check: dropping `fill={color}` on the Pin would leave the
    // token class (fill-overlay-ink) instead of the peer's own colour.
  });

  it('renders nothing when no collab session is active, even with stale peer data', () => {
    useViewerStore.setState({
      collabSession: null,
      collabPeers: [
        { clientId: 1, user: { name: 'Anna' }, cursor3d: { x: 0, y: 0, z: 0 }, lastUpdate: Date.now() },
      ] as never,
    });
    const { container, flush } = renderScene(<PeerPresenceLayer />);
    flush();
    assert.equal(container.querySelector('[data-peer-cursor-id]'), null);
    // Mutation check: removing the `sessionActive` gate would render the
    // peer even with no active session.
  });

  it('fades a stale peer toward the minimum opacity via the anchored Pin group style', () => {
    useViewerStore.setState({
      collabSession: FAKE_SESSION,
      collabPeers: [
        {
          clientId: 7,
          user: { name: 'Ben', color: '#00aaff' },
          cursor3d: { x: 1, y: 1, z: 0 },
          lastUpdate: Date.now() - 20_000, // well past the stale window
        },
      ] as never,
    });
    const { container, flush } = renderScene(<PeerPresenceLayer />);
    flush();
    const pin = container.querySelector('[data-peer-cursor-id="7"]') as SVGGElement;
    assert.equal(pin.style.opacity, '0.35');
    // Mutation check: dropping the staleness fade would leave opacity at 1.
  });
});
