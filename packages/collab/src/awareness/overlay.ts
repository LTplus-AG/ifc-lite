/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renderer-agnostic presence overlay (spec §7).
 *
 * Drop this into any DOM-based viewer (`packages/viewer`, custom apps,
 * embedded iframes) and it draws other peers' 2D cursors and
 * selection-color labels onto a transparent overlay <canvas>. Pure
 * 2D — apps that need 3D cursors layer them via Three.js / WebGPU on
 * top of the same `peerVisuals` data.
 *
 * Wiring (browser):
 *
 *     const overlay = createPresenceOverlay({
 *       container: document.getElementById('viewport'),
 *       viewport: 'plan',
 *     });
 *     session.presence.onUpdate((peers) => overlay.update(peers));
 *
 *     // Then on dispose:
 *     overlay.destroy();
 */

import type { PresenceMap } from './presence.js';
import { peerVisuals, cursorScreenPosition, type PeerVisual, type PeerVisualOptions } from './render.js';

export interface PresenceOverlayOptions extends PeerVisualOptions {
  /** Element to mount the overlay <canvas> over. Must be position:relative. */
  container: HTMLElement;
  /** Viewport name to filter cursor2d to. */
  viewport: string;
  /** Optional override for the cursor arrow size in CSS pixels. Default 14. */
  cursorSize?: number;
  /** Optional override for label font in CSS. Default '12px sans-serif'. */
  font?: string;
}

export interface PresenceOverlay {
  update(peers: PresenceMap): void;
  /** Resize the canvas to match the container (call on container resize). */
  resize(): void;
  destroy(): void;
}

const DPR = (): number => (typeof globalThis !== 'undefined' && typeof window !== 'undefined'
  ? window.devicePixelRatio || 1
  : 1);

/**
 * Mount a 2D presence overlay. Returns a controller that the app can
 * call `update(peers)` on whenever presence changes.
 */
export function createPresenceOverlay(opts: PresenceOverlayOptions): PresenceOverlay {
  if (typeof document === 'undefined') {
    throw new Error(
      '@ifc-lite/collab: createPresenceOverlay requires a browser DOM',
    );
  }
  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '10';
  opts.container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('@ifc-lite/collab: 2D canvas unavailable');

  const cursorSize = opts.cursorSize ?? 14;
  const font = opts.font ?? '12px sans-serif';

  const resize = () => {
    const r = opts.container.getBoundingClientRect();
    const dpr = DPR();
    canvas.width = Math.max(1, Math.floor(r.width * dpr));
    canvas.height = Math.max(1, Math.floor(r.height * dpr));
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();

  const update = (peers: PresenceMap) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const visuals = peerVisuals(peers, opts);
    for (const v of visuals) {
      drawPeer(ctx, v, opts.viewport, cursorSize, font);
    }
  };

  // Auto-resize via ResizeObserver if available.
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize());
    ro.observe(opts.container);
  }

  return {
    update,
    resize,
    destroy() {
      ro?.disconnect();
      canvas.remove();
    },
  };
}

function drawPeer(
  ctx: CanvasRenderingContext2D,
  v: PeerVisual,
  viewport: string,
  cursorSize: number,
  font: string,
): void {
  const pos = cursorScreenPosition(v, viewport);
  if (!pos) return;
  ctx.globalAlpha = v.opacity;
  ctx.fillStyle = v.color;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  // Cursor arrow.
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y);
  ctx.lineTo(pos.x, pos.y + cursorSize);
  ctx.lineTo(pos.x + cursorSize * 0.3, pos.y + cursorSize * 0.7);
  ctx.lineTo(pos.x + cursorSize * 0.7, pos.y + cursorSize * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Label.
  ctx.font = font;
  const padX = 6;
  const padY = 4;
  const textW = ctx.measureText(v.label).width;
  const labelX = pos.x + cursorSize + 4;
  const labelY = pos.y + cursorSize - 6;
  ctx.fillStyle = v.color;
  ctx.fillRect(labelX, labelY, textW + padX * 2, 16 + padY);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(v.label, labelX + padX, labelY + 14);
  ctx.globalAlpha = 1;
}
