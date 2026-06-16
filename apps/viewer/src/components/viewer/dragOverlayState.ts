/**
 * Pure state machine for the file drop-zone overlay.
 *
 * The overlay flickered when the cursor moved between child elements because
 * each child boundary fires its own `dragenter`/`dragleave` that bubbles up to
 * the container. We track a depth counter so the overlay only hides once the
 * cursor has truly left the container (depth back to zero), not when it merely
 * crosses into a nested child.
 */
export interface DragOverlayState {
  /** Net dragenter-minus-dragleave depth over the container subtree. */
  depth: number;
  /** Whether the drop overlay should be visible. */
  dragging: boolean;
}

export type DragOverlayEvent = 'enter' | 'leave' | 'drop';

export const initialDragOverlayState: DragOverlayState = { depth: 0, dragging: false };

/**
 * Compute the next overlay state for a drag event.
 *
 * - `enter`: increments depth; shows the overlay only when WebGPU is supported.
 * - `leave`: decrements depth; hides the overlay only once depth returns to zero.
 * - `drop`: resets depth and hides the overlay.
 */
export function reduceDragOverlay(
  state: DragOverlayState,
  event: DragOverlayEvent,
  webgpuSupported: boolean,
): DragOverlayState {
  switch (event) {
    case 'enter': {
      const depth = state.depth + 1;
      // Preserve prior `dragging` when WebGPU is unsupported (overlay stays hidden).
      return { depth, dragging: webgpuSupported ? true : state.dragging };
    }
    case 'leave': {
      const depth = state.depth - 1;
      if (depth <= 0) return { depth: 0, dragging: false };
      return { depth, dragging: state.dragging };
    }
    case 'drop':
      return { depth: 0, dragging: false };
  }
}
