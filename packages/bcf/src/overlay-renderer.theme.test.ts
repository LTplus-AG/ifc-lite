// @vitest-environment happy-dom
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The BCF overlay follows its host page's theme (#5491). It used to inject a
 * Tokyo-dark tooltip (`#1a1b26` / `#a9b1d6`) and a `#7aa2f7` pin whatever the
 * page looked like. These tests mount the real renderer, resolve the injected
 * stylesheet through `getComputedStyle`, and check that every colour comes
 * from the host's CSS custom properties, that the fallbacks apply when the
 * host defines none, and that the tooltip text is legible (WCAG 4.5:1) on its
 * own surface in each case.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { BCFOverlayRenderer } from './overlay-renderer.js';
import type { BCFMarker3D, BCFOverlayProjection } from './overlay.js';

const HOST_VARS = [
  '--color-popover',
  '--color-popover-foreground',
  '--color-muted-foreground',
  '--color-border',
  '--overlay-ink',
  '--overlay-accent',
  '--overlay-halo',
  '--overlay-status-danger',
] as const;
type HostVars = Record<(typeof HOST_VARS)[number], string>;

/** What a dark host page publishes (the viewer's Tokyo Night theme). */
const DARK_HOST: HostVars = {
  '--color-popover': '#16161e',
  '--color-popover-foreground': '#c0caf5',
  '--color-muted-foreground': '#828bb8',
  '--color-border': '#414868',
  '--overlay-ink': '#c0caf5',
  '--overlay-accent': '#7aa2f7',
  '--overlay-halo': '#1a1b26',
  '--overlay-status-danger': '#f7768e',
};

/** What a light host page publishes. */
const LIGHT_HOST: HostVars = {
  '--color-popover': '#fafafa',
  '--color-popover-foreground': '#09090b',
  '--color-muted-foreground': '#52525b',
  '--color-border': '#e4e4e7',
  '--overlay-ink': '#1f2335',
  '--overlay-accent': '#2e7de9',
  '--overlay-halo': '#ffffff',
  '--overlay-status-danger': '#f52a65',
};

function marker(overrides: Partial<BCFMarker3D> = {}): BCFMarker3D {
  return {
    topicGuid: 'topic-1',
    position: { x: 0, y: 0, z: 0 },
    title: 'Clash at grid C4',
    status: 'Open',
    priority: 'High',
    topicType: 'Error',
    commentCount: 2,
    hasViewpoint: true,
    positionSource: 'component',
    index: 1,
    ...overrides,
  };
}

const projection: BCFOverlayProjection = {
  projectToScreen: () => ({ x: 100, y: 100 }),
  getEntityBounds: () => null,
  getCanvasSize: () => ({ width: 800, height: 600 }),
  onCameraChange: () => () => {},
};

function setHost(vars: HostVars | null): void {
  const root = document.documentElement;
  for (const name of HOST_VARS) {
    if (vars) root.style.setProperty(name, vars[name]);
    else root.style.removeProperty(name);
  }
}

function mount(markers: BCFMarker3D[], activeGuid?: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const overlay = new BCFOverlayRenderer(host, projection);
  overlay.setMarkers(markers);
  if (activeGuid) overlay.setActiveMarker(activeGuid);
  const el = (guid: string) => host.querySelector<HTMLElement>(`[data-topic-guid="${guid}"]`)!;
  const style = (node: Element) => getComputedStyle(node);
  const q = (guid: string, sel: string) => el(guid).querySelector(sel)!;
  return {
    overlay,
    tooltip: (guid = 'topic-1') => style(q(guid, '.bcf-overlay-tooltip')),
    meta: (guid = 'topic-1') => style(q(guid, '.bcf-tooltip-meta')),
    title: (guid = 'topic-1') => style(q(guid, '.bcf-tooltip-title')),
    pin: (guid = 'topic-1') => style(q(guid, '.bcf-marker-pin')),
    index: (guid = 'topic-1') => style(q(guid, '.bcf-marker-index')),
    connector: () => host.querySelector<SVGLineElement>('.bcf-overlay-connector')!,
  };
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`expected a resolved #rrggbb colour, got ${JSON.stringify(hex)}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

afterEach(() => {
  setHost(null);
  document.body.innerHTML = '';
});

describe('BCFOverlayRenderer theme (#5491)', () => {
  it.each([
    ['dark', DARK_HOST],
    ['light', LIGHT_HOST],
  ] as const)('the tooltip takes its surface and text from a %s host page', (_name, vars) => {
    setHost(vars);
    const ui = mount([marker()]);

    expect(ui.tooltip().backgroundColor).toBe(vars['--color-popover']);
    expect(ui.tooltip().color).toBe(vars['--color-popover-foreground']);
    expect(ui.meta().color).toBe(vars['--color-muted-foreground']);
    expect(ui.tooltip().borderTopColor).toBe(vars['--color-border']);
    // The title inherits the tooltip's ink rather than hard-coding a light one.
    expect(ui.title().color).toBe(vars['--color-popover-foreground']);

    expect(contrast(ui.tooltip().color, ui.tooltip().backgroundColor)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ui.meta().color, ui.tooltip().backgroundColor)).toBeGreaterThanOrEqual(4.5);
    ui.overlay.dispose();
  });

  it('falls back to one legible light palette when the host defines no properties', () => {
    const ui = mount([marker()]);

    const bg = ui.tooltip().backgroundColor;
    expect(bg).toBe('#ffffff');
    expect(contrast(ui.tooltip().color, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ui.meta().color, bg)).toBeGreaterThanOrEqual(4.5);
    ui.overlay.dispose();
  });

  it('colours pins by status token, and an unknown status by ink, not a fixed blue', () => {
    setHost(DARK_HOST);
    const ui = mount([
      marker({ topicGuid: 'open', status: 'Open' }),
      marker({ topicGuid: 'odd', status: 'Needs triage', index: 2 }),
    ]);

    expect(ui.pin('open').backgroundColor).toBe(DARK_HOST['--overlay-status-danger']);
    expect(ui.pin('odd').backgroundColor).toBe(DARK_HOST['--overlay-ink']);
    expect(ui.index('open').color).toBe(DARK_HOST['--overlay-halo']);
    // The connector follows the same token, through a custom property the
    // stylesheet reads (a presentation attribute cannot hold var()).
    expect(getComputedStyle(ui.connector()).stroke).toBe(DARK_HOST['--overlay-status-danger']);
    ui.overlay.dispose();
  });

  it('lets a host stylesheet restyle the connector without !important', () => {
    setHost(DARK_HOST);
    const override = document.createElement('style');
    override.textContent = '.bcf-overlay-connector { stroke: #00ff00; }';
    document.head.appendChild(override);
    const ui = mount([marker()]);

    expect(getComputedStyle(ui.connector()).stroke).toBe('#00ff00');
    override.remove();
    ui.overlay.dispose();
  });

  it('rings the active marker in the one selection accent', () => {
    setHost(LIGHT_HOST);
    const ui = mount([marker()], 'topic-1');

    expect(ui.pin().boxShadow).toContain(LIGHT_HOST['--overlay-accent']);
    ui.overlay.dispose();
  });
});
