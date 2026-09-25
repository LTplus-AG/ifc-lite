/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Class names, theme hooks and the shared stylesheet of `BCFOverlayRenderer`.
 * Internal to the package; not re-exported from `index.ts`.
 */

export const MARKER_CLASS = 'bcf-overlay-marker';
export const CONNECTOR_CLASS = 'bcf-overlay-connector';
export const ACTIVE_CLASS = 'bcf-overlay-active';
export const TOOLTIP_CLASS = 'bcf-overlay-tooltip';

/**
 * Theme hooks (#5491). The overlay takes every colour from CSS custom
 * properties on its host page instead of hard-coding one palette, so its
 * tooltip is legible on a light page as well as a dark one:
 *
 * - the tooltip is a card on the host's surface: `--color-popover`,
 *   `--color-popover-foreground`, `--color-muted-foreground`, `--color-border`
 *   (the shadcn / Tailwind v4 theme names);
 * - marks use the overlay tokens: `--overlay-status-*` per topic status,
 *   `--overlay-ink` for an unknown status, `--overlay-accent` for the active
 *   marker's ring (the one selection colour), `--overlay-halo` for the pin's
 *   outline and index.
 *
 * Every fallback is taken from one light palette (Tokyo Night Day on a white
 * card), so a host that defines none of these still gets a legible pair.
 */
export const THEME = {
  surface: 'var(--color-popover, #ffffff)',
  surfaceInk: 'var(--color-popover-foreground, #1f2335)',
  surfaceInkMuted: 'var(--color-muted-foreground, #5a6aa4)',
  surfaceBorder: 'var(--color-border, #c4c8da)',
  ink: 'var(--overlay-ink, #1f2335)',
  accent: 'var(--overlay-accent, #2e7de9)',
  halo: 'var(--overlay-halo, #ffffff)',
} as const;

/** Pin and connector colors keyed by BCF topic status */
export const STATUS_COLORS: Record<string, string> = {
  open: 'var(--overlay-status-danger, #f52a65)',
  'in progress': 'var(--overlay-status-warn, #8c6c3e)',
  resolved: 'var(--overlay-status-ok, #587539)',
  closed: 'var(--overlay-ink-muted, #5a6aa4)',
};

export const STATUS_ICONS: Record<string, string> = {
  open: '●',
  'in progress': '◐',
  resolved: '✓',
  closed: '○',
};

/** The overlay's stylesheet, injected once per document by the renderer. */
export const OVERLAY_STYLES = `
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
    background: var(--marker-color, ${THEME.ink});
    transform: rotate(-45deg);
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px solid ${THEME.halo};
    box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }

  .${MARKER_CLASS}:hover .bcf-marker-pin {
    transform: rotate(-45deg) scale(1.2);
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  }

  .${ACTIVE_CLASS} .bcf-marker-pin {
    transform: rotate(-45deg) scale(1.25);
    box-shadow: 0 0 0 3px ${THEME.accent}, 0 4px 16px rgba(0,0,0,0.4);
    animation: bcf-pulse 1.8s ease-in-out infinite;
  }

  .bcf-marker-index {
    transform: rotate(45deg);
    font-size: 11px;
    font-weight: 700;
    color: ${THEME.halo};
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
    background: ${THEME.surface};
    color: ${THEME.surfaceInk};
    border: 1px solid ${THEME.surfaceBorder};
    border-radius: 4px;
    padding: 8px 12px;
    min-width: 160px;
    max-width: 260px;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    line-height: 1.4;
    white-space: nowrap;
    z-index: 100;
    pointer-events: none;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  }

  .${TOOLTIP_CLASS}::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 5px solid transparent;
    border-top-color: ${THEME.surfaceBorder};
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
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .bcf-tooltip-meta {
    margin-top: 3px;
    font-size: 10px;
    color: ${THEME.surfaceInkMuted};
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* Connector lines */
  .${CONNECTOR_CLASS} {
    pointer-events: none;
    stroke: var(--bcf-connector-color, ${THEME.ink});
  }

  /* Pulse animation for active marker */
  @keyframes bcf-pulse {
    0%, 100% { box-shadow: 0 0 0 3px ${THEME.accent}, 0 4px 16px rgba(0,0,0,0.4); }
    50% { box-shadow: 0 0 0 6px color-mix(in srgb, ${THEME.accent} 35%, transparent), 0 4px 16px rgba(0,0,0,0.4); }
  }
`;
