/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollabSession } from '../src/session.js';
import { mountPresenceInViewer } from '../src/viewer-bridge.js';

/**
 * Browser-only feature; we install a minimal DOM stub so the test
 * runs in plain Node without pulling in jsdom.
 */
function installDomStub(): { teardown: () => void } {
  const listeners = new Map<EventTarget, Map<string, Set<EventListener>>>();

  class FakeEventTarget {
    addEventListener(type: string, listener: EventListener) {
      const t = listeners.get(this as unknown as EventTarget) ?? new Map<string, Set<EventListener>>();
      const set = t.get(type) ?? new Set<EventListener>();
      set.add(listener);
      t.set(type, set);
      listeners.set(this as unknown as EventTarget, t);
    }
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(this as unknown as EventTarget)?.get(type)?.delete(listener);
    }
    dispatchEvent(event: { type: string }): boolean {
      const set = listeners.get(this as unknown as EventTarget)?.get(event.type);
      set?.forEach((l) => (l as (e: unknown) => void)(event));
      return true;
    }
  }
  class FakeElement extends FakeEventTarget {
    children: FakeElement[] = [];
    parent: FakeElement | null = null;
    style: Record<string, string> = {};
    width = 800;
    height = 600;
    appendChild(child: FakeElement) {
      this.children.push(child);
      child.parent = this;
    }
    remove() {
      this.parent?.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, right: this.width, bottom: this.height, width: this.width, height: this.height, x: 0, y: 0, toJSON: () => '' };
    }
    querySelector(sel: string) {
      if (sel === 'canvas') return this.children.find((c) => (c as unknown as { _isCanvas?: boolean })._isCanvas) ?? null;
      return null;
    }
    setAttribute() {}
    hasAttribute() { return false; }
    removeAttribute() {}
    getContext() {
      return {
        clearRect: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        closePath: () => {},
        fill: () => {},
        stroke: () => {},
        fillRect: () => {},
        fillText: () => {},
        measureText: (s: string) => ({ width: s.length * 6 }),
        setTransform: () => {},
        set fillStyle(_v: string) {},
        get fillStyle() { return '#000000'; },
        set strokeStyle(_v: string) {},
        get strokeStyle() { return '#000000'; },
        set lineWidth(_v: number) {},
        get lineWidth() { return 1; },
        set globalAlpha(_v: number) {},
        get globalAlpha() { return 1; },
        set font(_v: string) {},
        get font() { return ''; },
      };
    }
  }
  class FakeMouseEvent {
    type: string;
    clientX: number;
    clientY: number;
    constructor(type: string, init: { clientX?: number; clientY?: number } = {}) {
      this.type = type;
      this.clientX = init.clientX ?? 0;
      this.clientY = init.clientY ?? 0;
    }
  }

  const fakeDoc = {
    createElement(tag: string) {
      const el = new FakeElement();
      if (tag === 'canvas') {
        (el as unknown as { _isCanvas: boolean })._isCanvas = true;
      }
      return el;
    },
  };

  const g = globalThis as unknown as Record<string, unknown>;
  const saved = {
    document: g.document,
    MouseEvent: g.MouseEvent,
    ResizeObserver: g.ResizeObserver,
    window: g.window,
  };
  g.document = fakeDoc;
  g.MouseEvent = FakeMouseEvent as unknown as typeof MouseEvent;
  g.window = { devicePixelRatio: 1 };
  // Don't install ResizeObserver — overlay handles its absence.
  delete g.ResizeObserver;

  return {
    teardown() {
      g.document = saved.document;
      g.MouseEvent = saved.MouseEvent;
      g.ResizeObserver = saved.ResizeObserver;
      g.window = saved.window;
    },
  };
}

describe('mountPresenceInViewer', () => {
  let stub: { teardown: () => void };
  beforeEach(() => {
    stub = installDomStub();
  });
  afterEach(() => {
    stub.teardown();
  });

  it('mounts a canvas, forwards mousemove → setCursor2d, tears down cleanly', async () => {
    const session = await createCollabSession({
      roomId: 'r',
      user: { id: 'u', name: 'U' },
      provider: 'memory',
      presence: { updateRateHz: 1000 },
    });

    const container = (
      globalThis as unknown as { document: { createElement: (t: string) => unknown } }
    ).document.createElement('div') as {
      appendChild: (c: unknown) => void;
      dispatchEvent: (e: unknown) => boolean;
      querySelector: (s: string) => unknown;
      children: unknown[];
    };

    const teardown = mountPresenceInViewer({
      session,
      container: container as unknown as HTMLElement,
      viewport: 'plan',
    });
    expect(container.querySelector('canvas')).toBeTruthy();

    const M = (globalThis as unknown as { MouseEvent: new (t: string, i?: object) => unknown }).MouseEvent;
    container.dispatchEvent(new M('mousemove', { clientX: 100, clientY: 200 }));
    await new Promise((r) => setTimeout(r, 30));

    const self = session.presence.getSelf();
    expect(self?.cursor2d?.viewport).toBe('plan');
    expect(self?.cursor2d?.pos).toEqual({ x: 100, y: 200 });

    container.dispatchEvent(new M('mouseleave'));
    await new Promise((r) => setTimeout(r, 30));
    expect(session.presence.getSelf()?.cursor2d).toBeUndefined();

    teardown();
    expect(container.children.length).toBe(0);
    session.dispose();
  });
});
