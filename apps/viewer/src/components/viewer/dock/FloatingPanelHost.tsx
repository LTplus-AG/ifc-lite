/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renders the floating workspace panels (issue #1201) as an overlay over the
 * viewport. The container is click-through (`pointer-events-none`); each
 * {@link FloatingPanel} re-enables pointer events for itself, so the 3D scene
 * stays interactive in the gaps between windows.
 */

import { useLayoutEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import { getPanelDef } from '@/lib/panels/registry';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { usePanelControls } from '@/hooks/usePanelControls';
import { FloatingPanel, type SnapBounds } from './FloatingPanel';
import type { FloatingArea } from './floating-panel-geometry';

const FLOAT_Z_BASE = 30;

/** ViewerLayout tags the 3D viewport with this so edge snaps confine to it. */
const SNAP_BOUNDS_SELECTOR = '[data-floating-snap-bounds]';

export function FloatingPanelHost() {
  const floatingPanels = useViewerStore((s) => s.floatingPanels);
  const setFloatingPanelRect = useViewerStore((s) => s.setFloatingPanelRect);
  const snapFloatingPanel = useViewerStore((s) => s.snapFloatingPanel);
  const bringFloatingPanelToFront = useViewerStore((s) => s.bringFloatingPanelToFront);
  const { closePanel, dockPanel } = usePanelControls();

  // The region edge-snapped panels dock into: the 3D viewport, in window
  // coordinates. Tracked only while a panel is actually snapped so free-float /
  // empty states stay observer-free. Kept in sync with sidebar / hierarchy
  // resizes (and window resizes) so a dock never drifts under the toolbar or
  // over the rail (#1245).
  const hasSnapped = floatingPanels.some((p) => p.snap !== 'free');
  const [snapBounds, setSnapBounds] = useState<SnapBounds | null>(null);
  useLayoutEffect(() => {
    if (!hasSnapped) {
      setSnapBounds(null);
      return;
    }
    const el = document.querySelector(SNAP_BOUNDS_SELECTOR) as HTMLElement | null;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSnapBounds({
        top: r.top,
        left: r.left,
        right: Math.max(0, window.innerWidth - r.right),
        bottom: Math.max(0, window.innerHeight - r.bottom),
        width: r.width,
        height: r.height,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [hasSnapped]);

  // The window free panels are clamped into (#5854), tracked only while a
  // panel floats so the empty state stays listener-free. Its `top` is the
  // viewport region's top, i.e. the toolbar bottom, so a clamped panel's title
  // bar never lands under the z-50 toolbar (#5957).
  const hasPanels = floatingPanels.length > 0;
  const [area, setArea] = useState<FloatingArea | null>(null);
  useLayoutEffect(() => {
    if (!hasPanels) return;
    const el = document.querySelector(SNAP_BOUNDS_SELECTOR) as HTMLElement | null;
    const measure = () => setArea({
      width: window.innerWidth,
      height: window.innerHeight,
      top: Math.max(0, el?.getBoundingClientRect().top ?? 0),
    });
    measure();
    const ro = el ? new ResizeObserver(measure) : null;
    ro?.observe(el as HTMLElement);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [hasPanels]);

  if (!hasPanels) return null;

  return (
    // Fixed viewport overlay: FloatingPanelState.x/y are documented as viewport
    // coordinates and seeded from getBoundingClientRect() on detach. An
    // `absolute` host would add ViewerLayout's content-container offset (it sits
    // below the toolbar), making freshly detached panels jump (#1208).
    <div className="fixed inset-0 z-30 pointer-events-none">
      {floatingPanels.map((panel, i) => {
        const def = getPanelDef(panel.id);
        return (
          <FloatingPanel
            key={panel.id}
            panel={panel}
            title={def?.title ?? panel.id}
            zIndex={FLOAT_Z_BASE + i}
            bounds={snapBounds}
            area={area}
            onRect={(rect) => setFloatingPanelRect(panel.id, rect)}
            onSnap={(snap) => snapFloatingPanel(panel.id, snap)}
            onFocus={() => bringFloatingPanelToFront(panel.id)}
            onDock={() => dockPanel(panel.id)}
            onClose={() => closePanel(panel.id)}
          >
            {renderPanelBody(panel.id, () => closePanel(panel.id))}
          </FloatingPanel>
        );
      })}
    </div>
  );
}
