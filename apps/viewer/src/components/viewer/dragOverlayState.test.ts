import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialDragOverlayState,
  reduceDragOverlay,
  type DragOverlayState,
} from './dragOverlayState';

test('enter shows overlay and increments depth when WebGPU supported', () => {
  const next = reduceDragOverlay(initialDragOverlayState, 'enter', true);
  assert.deepEqual(next, { depth: 1, dragging: true });
});

test('enter increments depth but keeps overlay hidden when WebGPU unsupported', () => {
  const next = reduceDragOverlay(initialDragOverlayState, 'enter', false);
  assert.deepEqual(next, { depth: 1, dragging: false });
});

test('overlay stays visible across nested child boundary crossings (no flicker)', () => {
  // Cursor enters the container, then crosses into a nested child:
  // child dragenter (depth 2) fires before the container dragleave (depth 1).
  let state: DragOverlayState = initialDragOverlayState;
  state = reduceDragOverlay(state, 'enter', true); // enter container
  assert.equal(state.dragging, true);

  state = reduceDragOverlay(state, 'enter', true); // enter child
  assert.equal(state.depth, 2);
  assert.equal(state.dragging, true);

  state = reduceDragOverlay(state, 'leave', true); // leave previous element
  assert.equal(state.depth, 1);
  assert.equal(state.dragging, true, 'overlay must remain visible mid-traversal');
});

test('overlay hides only once depth returns to zero', () => {
  let state: DragOverlayState = { depth: 2, dragging: true };
  state = reduceDragOverlay(state, 'leave', true);
  assert.deepEqual(state, { depth: 1, dragging: true });

  state = reduceDragOverlay(state, 'leave', true);
  assert.deepEqual(state, { depth: 0, dragging: false });
});

test('leave clamps depth at zero and hides overlay even if it goes negative', () => {
  // Some browsers can fire an unbalanced dragleave; depth must never go negative.
  const state = reduceDragOverlay(initialDragOverlayState, 'leave', true);
  assert.deepEqual(state, { depth: 0, dragging: false });
});

test('drop resets depth to zero and hides overlay', () => {
  const state = reduceDragOverlay({ depth: 3, dragging: true }, 'drop', true);
  assert.deepEqual(state, { depth: 0, dragging: false });
});

test('drop resets even when WebGPU unsupported', () => {
  const state = reduceDragOverlay({ depth: 1, dragging: false }, 'drop', false);
  assert.deepEqual(state, { depth: 0, dragging: false });
});
