/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DOM scene primitives (#5486): `WorldLabel`, `AnchoredCard`,
 * `CursorInput`. Same projector-driven visibility contract as the SVG
 * primitives, plus the one shared card surface and `tabular-nums`.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, type } from '@/test/render.js';
import { renderScene } from '../test/scene-test-support.js';
import { WorldLabel } from './WorldLabel.js';
import { AnchoredCard } from './AnchoredCard.js';
import { CursorInput } from './CursorInput.js';

afterEach(() => cleanup());

describe('WorldLabel', () => {
  it('is a card, tabular-nums, ink by default, and hidden until projected', () => {
    const { container, flush } = renderScene(<WorldLabel worldPoint={{ x: 4, y: 8, z: 0 }}>1.20 m</WorldLabel>);
    const outer = container.querySelector('[data-scene-primitive="world-label"]') as HTMLDivElement;
    assert.equal(outer.style.display, 'none');
    flush();
    assert.equal(outer.style.display, '');
    assert.equal(outer.style.transform, 'translate(4px, 8px)');
    const card = outer.firstElementChild as HTMLElement;
    assert.match(card.className, /tabular-nums/);
    assert.match(card.className, /border-border/, 'passive labels use the neutral border, not accent');
    assert.equal(card.textContent, '1.20 m');
  });

  it('switches to the accent border when active', () => {
    const { container, flush } = renderScene(
      <WorldLabel worldPoint={{ x: 0, y: 0, z: 0 }} active>
        3.40 m
      </WorldLabel>,
    );
    flush();
    const card = container.querySelector('[data-scene-primitive="world-label"]')!.firstElementChild as HTMLElement;
    assert.match(card.className, /border-overlay-accent/);
    // Mutation check: dropping the `active ? … : …` branch (always ink border)
    // would make this assertion fail while the passive test above still passes.
  });

  it('keeps its own offset transform independent of the projector-owned outer transform', () => {
    const { container, flush } = renderScene(
      <WorldLabel worldPoint={{ x: 100, y: 100, z: 0 }} offset={{ dx: 5, dy: -5 }}>
        x
      </WorldLabel>,
    );
    flush();
    const outer = container.querySelector('[data-scene-primitive="world-label"]') as HTMLDivElement;
    const inner = outer.firstElementChild as HTMLElement;
    assert.equal(outer.style.transform, 'translate(100px, 100px)');
    assert.equal(inner.style.transform, 'translate(5px, -5px)');
    // Mutation check: applying the projector's per-frame transform to the SAME
    // element as the static offset would overwrite one with the other.
  });
});

describe('AnchoredCard', () => {
  it('is interactive (pointer-events-auto) unlike the inert WorldLabel', () => {
    const { container, flush } = renderScene(
      <AnchoredCard worldPoint={{ x: 1, y: 1, z: 0 }}>
        <button type="button">go</button>
      </AnchoredCard>,
    );
    flush();
    const card = container.querySelector('[data-scene-primitive="anchored-card"]')!.firstElementChild as HTMLElement;
    assert.match(card.className, /pointer-events-auto/);
    assert.ok(card.querySelector('button'));
  });
});

describe('CursorInput', () => {
  it('commits on Enter and cancels on Escape', () => {
    const { container, flush } = renderScene(
      <Harness />,
    );
    flush();
    const input = container.querySelector('input') as HTMLInputElement;
    assert.ok(input);
    type(input, '2.5');
    act(() => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    assert.equal(lastCommit, '2.5');
    act(() => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    assert.equal(cancelled, true);
  });
});

let lastCommit = '';
let cancelled = false;

function Harness() {
  return (
    <CursorInput
      worldPoint={{ x: 2, y: 2, z: 0 }}
      value="2.5"
      onChange={() => {}}
      onCommit={(v) => {
        lastCommit = v;
      }}
      onCancel={() => {
        cancelled = true;
      }}
      ariaLabel="length"
    />
  );
}
