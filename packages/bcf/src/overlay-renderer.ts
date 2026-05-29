/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF 3D Overlay Renderer — pure DOM, no framework dependency.
 *
 * Renders BCFMarker3D items as positioned HTML elements overlaid on a 3D
 * canvas. Works with any renderer that implements BCFOverlayProjection.
 *
 * Features:
 *   - Markers anchored to 3D objects — track correctly during orbit/pan/zoom
 *   - Color-coded by topic status
 *   - Click, hover callbacks
 *   - Continuous re-projection every frame via onCameraChange
 *   - Connector lines from marker to projected anchor point
 *   - Depth-based scaling (farther markers appear smaller)
 */

import type { BCFMarker3D, BCFOverlayProjection } from './overlay.js';

// ============================================================================
// Constants
// ============================================================================

const MARKER_CLASS = 'bcf-overlay-marker';
const CONNECTOR_CLASS = 'bcf-overlay-connector';
const ACTIVE_CLASS = 'bcf-overlay-active';
const TOOLTIP_CLASS = 'bcf-overlay-tooltip';

/** Pin and connector colors keyed by BCF topic status */
const STATUS_COLORS: Record<string, string> = {
  open: '#f7768e',
  'in progress': '#e0af68',
  resolved: '#9ece6a',
  closed: '#565f89',
};

const STATUS_ICONS: Record<string, string> = {
  open: '●',
  'in progress': '◐',
  resolved: '✓',
  closed: '○',
};

// ============================================================================
// Overlay Renderer
// ============================================================================

export interface BCFOverlayRendererOptions {
  /** Show connector lines from marker to 3D anchor (default true) */
  showConnectors?: boolean;
  /** Show tooltip on hover (default true) */
  showTooltips?: boolean;
  /** Minimum marker scale at far distance (default 0.65) */
  minScale?: number;
  /** Maximum marker scale at near distance (default 1.0) */
  maxScale?: number;
  /** Offset in pixels above the projected point (default 36) */
  verticalOffset?: number;
}

export class BCFOverlayRenderer {
  private container: HTMLDivElement;
  private svgLayer: SVGSVGElement;
  private markerElements: Map<string, HTMLDivElement> = new Map();
  private connectorElements: Map<string, SVGLineElement> = new Map();
  private markers: BCFMarker3D[] = [];
  private activeMarkerId: string | null = null;
  private projection: BCFOverlayProjection;
  private unsubCamera: (() => void) | null = null;
  private clickCallbacks: Array<(topicGuid: string) => void> = [];
  private hoverCallbacks: Array<(topicGuid: string | null) => void> = [];
  private opts: Required<BCFOverlayRendererOptions>;
  private _visible = true;
  private _disposed = false;

  constructor(
    parentElement: HTMLElement,
    projection: BCFOverlayProjection,
    options?: BCFOverlayRendererOptions,
  ) {
    this.projection = projection;
    this.opts = {
      showConnectors: options?.showConnectors ?? true,
      showTooltips: options?.showTooltips ?? true,
      minScale: options?.minScale ?? 0.65,
      maxScale: options?.maxScale ?? 1.0,
      verticalOffset: options?.verticalOffset ?? 36,
    };

    // Create overlay container (positioned over the canvas)
    this.container = document.createElement('div');
    this.container.style.cssText =
      'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:20;';
    parentElement.appendChild(this.container);

    // Create SVG layer for connector lines
    this.svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svgLayer.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;';
    this.container.appendChild(this.svgLayer);

    // Inject shared styles once
    this.injectStyles();

    // Subscribe to camera changes — callback fires synchronously in the
    // polling RAF so we project in the same frame, zero lag.
    this.unsubCamera = projection.onCameraChange(() => this.updatePositions());
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /** Update the set of markers to display */
  setMarkers(markers: BCFMarker3D[]): void {
    this.markers = markers;

    // Remove elements for markers no longer present
    const newGuids = new Set(markers.map((m) => m.topicGuid));
    for (const [guid, el] of this.markerElements) {
      if (!newGuids.has(guid)) {
        el.remove();
        this.markerElements.delete(guid);
      }
    }
    for (const [guid, el] of this.connectorElements) {
      if (!newGuids.has(guid)) {
        el.remove();
        this.connectorElements.delete(guid);
      }
    }

    // Create/update marker elements
    for (const marker of markers) {
      if (!this.markerElements.has(marker.topicGuid)) {
        this.createMarkerElement(marker);
      } else {
        this.updateMarkerContent(marker);
      }
    }

    this.updatePositions();
  }

  /** Highlight a specific marker as active */
  setActiveMarker(topicGuid: string | null): void {
    if (this.activeMarkerId) {
      const prev = this.markerElements.get(this.activeMarkerId);
      if (prev) prev.classList.remove(ACTIVE_CLASS);
    }
    this.activeMarkerId = topicGuid;
    if (topicGuid) {
      const el = this.markerElements.get(topicGuid);
      if (el) el.classList.add(ACTIVE_CLASS);
    }
  }

  /** Show/hide the entire overlay layer */
  setVisible(visible: boolean): void {
    this._visible = visible;
    this.container.style.display = visible ? '' : 'none';
  }

  /** Register click callback */
  onMarkerClick(callback: (topicGuid: string) => void): () => void {
    this.clickCallbacks.push(callback);
    return () => {
      this.clickCallbacks = this.clickCallbacks.filter((c) => c !== callback);
    };
  }

  /** Register hover callback */
  onMarkerHover(callback: (topicGuid: string | null) => void): () => void {
    this.hoverCallbacks.push(callback);
    return () => {
      this.hoverCallbacks = this.hoverCallbacks.filter((c) => c !== callback);
    };
  }

  /**
   * Re-project all markers from world space to screen space.
   * Called directly from the camera-change polling RAF — no extra
   * scheduling, so markers track the camera with zero frame delay.
   */
  updatePositions(): void {
    if (this._disposed || !this._visible) return;
    const { width, height } = this.projection.getCanvasSize();
    if (width === 0 || height === 0) return;

    const camPos = this.projection.getCameraPosition?.();

    for (const marker of this.markers) {
      const el = this.markerElements.get(marker.topicGuid);
      if (!el) continue;

      // Project the marker's world-space position to screen
      const markerScreen = this.projection.projectToScreen(marker.position);

      if (
        !markerScreen ||
        markerScreen.x < -80 || markerScreen.y < -80 ||
        markerScreen.x > width + 80 || markerScreen.y > height + 80
      ) {
        el.style.display = 'none';
        const conn = this.connectorElements.get(marker.topicGuid);
        if (conn) conn.style.display = 'none';
        continue;
      }

      el.style.display = '';

      // Depth-based scaling: farther markers appear smaller
      let scale = 1.0;
      if (camPos) {
        const dx = marker.position.x - camPos.x;
        const dy = marker.position.y - camPos.y;
        const dz = marker.position.z - camPos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const t = Math.max(0, Math.min(1, (dist - 20) / 180));
        scale = this.opts.maxScale + t * (this.opts.minScale - this.opts.maxScale);
      }

      // Position the marker pin at the projected point
      const markerX = markerScreen.x;
      const markerY = markerScreen.y;

      el.style.transform =
        `translate(${markerX}px, ${markerY}px) translate(-50%, -100%) scale(${scale.toFixed(3)})`;

      // Depth-based opacity: far markers slightly translucent
      const opacity = camPos
        ? 0.6 + (1 - Math.max(0, Math.min(1, (Math.sqrt(
            (marker.position.x - camPos.x) ** 2 +
            (marker.position.y - camPos.y) ** 2 +
            (marker.position.z - camPos.z) ** 2
          ) - 20) / 250))) * 0.4
        : 1;
      el.style.opacity = opacity.toFixed(2);

      // Connector line from marker to the anchor point (bbox top-center)
      if (this.opts.showConnectors) {
        const anchor = marker.connectorAnchor ?? marker.position;
        const anchorScreen = this.projection.projectToScreen(anchor);

        let conn = this.connectorElements.get(marker.topicGuid);
        if (!conn) {
          conn = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          conn.classList.add(CONNECTOR_CLASS);
          this.svgLayer.appendChild(conn);
          this.connectorElements.set(marker.topicGuid, conn);
        }

        if (!anchorScreen) {
          conn.style.display = 'none';
          continue;
        }

        conn.style.display = '';
        const color = this.getStatusColor(marker.status);
        conn.setAttribute('x1', String(markerX));
        conn.setAttribute('y1', String(markerY));
        conn.setAttribute('x2', String(anchorScreen.x));
        conn.setAttribute('y2', String(anchorScreen.y));
        conn.setAttribute('stroke', color);
        conn.setAttribute('stroke-width', '1.5');
        conn.setAttribute('stroke-dasharray', '3 2');
        conn.setAttribute('stroke-opacity', String((opacity * 0.5).toFixed(2)));
      }
    }
  }

  /** Clean up all DOM elements and listeners */
  dispose(): void {
    this._disposed = true;
    if (this.unsubCamera) this.unsubCamera();
    this.container.remove();
    this.markerElements.clear();
    this.connectorElements.clear();
    this.clickCallbacks = [];
    this.hoverCallbacks = [];
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private createMarkerElement(marker: BCFMarker3D): void {
    const el = document.createElement('div');
    el.className = MARKER_CLASS;
    el.dataset.topicGuid = marker.topicGuid;

    this.updateMarkerInnerHTML(el, marker);

    // Click handler
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      for (const cb of this.clickCallbacks) cb(marker.topicGuid);
    });

    // Hover handlers
    el.addEventListener('mouseenter', () => {
      for (const cb of this.hoverCallbacks) cb(marker.topicGuid);
      const tooltip = el.querySelector(`.${TOOLTIP_CLASS}`) as HTMLElement | null;
      if (tooltip) tooltip.style.display = '';
    });
    el.addEventListener('mouseleave', () => {
      for (const cb of this.hoverCallbacks) cb(null);
      const tooltip = el.querySelector(`.${TOOLTIP_CLASS}`) as HTMLElement | null;
      if (tooltip) tooltip.style.display = 'none';
    });

    if (marker.topicGuid === this.activeMarkerId) {
      el.classList.add(ACTIVE_CLASS);
    }

    this.container.appendChild(el);
    this.markerElements.set(marker.topicGuid, el);
  }

  private updateMarkerContent(marker: BCFMarker3D): void {
    const el = this.markerElements.get(marker.topicGuid);
    if (!el) return;
    this.updateMarkerInnerHTML(el, marker);
    if (marker.topicGuid === this.activeMarkerId) {
      el.classList.add(ACTIVE_CLASS);
    } else {
      el.classList.remove(ACTIVE_CLASS);
    }
  }

  private updateMarkerInnerHTML(el: HTMLDivElement, marker: BCFMarker3D): void {
    const color = this.getStatusColor(marker.status);
    const statusIcon = STATUS_ICONS[marker.status.toLowerCase()] ?? '●';
    const priorityLabel = marker.priority ? ` · ${marker.priority}` : '';

    el.innerHTML = `
      <div class="bcf-marker-pin" style="--marker-color:${color};">
        <span class="bcf-marker-index">${marker.index}</span>
      </div>
      <div class="${TOOLTIP_CLASS}" style="display:none;">
        <div class="bcf-tooltip-header">
          <span class="bcf-tooltip-status" style="color:${color}">${statusIcon}</span>
          <span class="bcf-tooltip-title">${this.escapeHtml(marker.title)}</span>
        </div>
        <div class="bcf-tooltip-meta">
          ${this.escapeHtml(marker.status)}${priorityLabel}${marker.commentCount > 0 ? ` · ${marker.commentCount} comment${marker.commentCount !== 1 ? 's' : ''}` : ''}
        </div>
      </div>
    `;
  }

  private getStatusColor(status: string): string {
    return STATUS_COLORS[status.toLowerCase()] ?? '#7aa2f7';
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // --------------------------------------------------------------------------
  // Shared CSS (injected once per document)
  // --------------------------------------------------------------------------

  private static stylesInjected = false;

  private injectStyles(): void {
    if (BCFOverlayRenderer.stylesInjected) return;
    BCFOverlayRenderer.stylesInjected = true;

    const style = document.createElement('style');
    style.textContent = `
      /* BCF 3D Overlay Markers */

      .${MARKER_CLASS} {
        position: absolute;
        left: 0;
        top: 0;
        pointer-events: auto;
        cursor: pointer;
        will-change: transform, opacity;
        z-index: 21;
        filter: drop-shadow(0 2px 6px rgba(0,0,0,0.35));
        transform-origin: center bottom;
      }

      .bcf-marker-pin {
        width: 28px;
        height: 28px;
        border-radius: 50% 50% 50% 0;
        background: var(--marker-color, #7aa2f7);
        transform: rotate(-45deg);
        display: flex;
        align-items: center;
        justify-content: center;
        border: 2px solid rgba(255,255,255,0.9);
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        transition: transform 0.15s ease, box-shadow 0.15s ease;
      }

      .${MARKER_CLASS}:hover .bcf-marker-pin {
        transform: rotate(-45deg) scale(1.2);
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      }

      .${ACTIVE_CLASS} .bcf-marker-pin {
        transform: rotate(-45deg) scale(1.25);
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--marker-color, #7aa2f7) 35%, transparent), 0 4px 16px rgba(0,0,0,0.4);
        animation: bcf-pulse 1.8s ease-in-out infinite;
      }

      .bcf-marker-index {
        transform: rotate(45deg);
        font-size: 11px;
        font-weight: 700;
        color: white;
        font-family: ui-monospace, monospace;
        line-height: 1;
        user-select: none;
      }

      /* Tooltip */
      .${TOOLTIP_CLASS} {
        position: absolute;
        bottom: calc(100% + 6px);
        left: 50%;
        transform: translateX(-50%);
        background: #1a1b26;
        color: #a9b1d6;
        border: 1px solid #3b4261;
        padding: 8px 12px;
        min-width: 160px;
        max-width: 260px;
        font-family: ui-monospace, monospace;
        font-size: 11px;
        line-height: 1.4;
        white-space: nowrap;
        z-index: 100;
        pointer-events: none;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      }

      .${TOOLTIP_CLASS}::after {
        content: '';
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%);
        border: 5px solid transparent;
        border-top-color: #3b4261;
      }

      .bcf-tooltip-header {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .bcf-tooltip-status {
        font-size: 10px;
        flex-shrink: 0;
      }

      .bcf-tooltip-title {
        font-weight: 600;
        color: #c0caf5;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .bcf-tooltip-meta {
        margin-top: 3px;
        font-size: 10px;
        color: #565f89;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      /* Connector lines */
      .${CONNECTOR_CLASS} {
        pointer-events: none;
      }

      /* Pulse animation for active marker */
      @keyframes bcf-pulse {
        0%, 100% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--marker-color, #7aa2f7) 35%, transparent), 0 4px 16px rgba(0,0,0,0.4); }
        50% { box-shadow: 0 0 0 8px color-mix(in srgb, var(--marker-color, #7aa2f7) 10%, transparent), 0 4px 16px rgba(0,0,0,0.4); }
      }
    `;
    document.head.appendChild(style);
  }
}
