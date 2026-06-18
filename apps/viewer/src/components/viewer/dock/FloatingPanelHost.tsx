/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renders the floating workspace panels (issue #1201) as an overlay over the
 * viewport. The container is click-through (`pointer-events-none`); each
 * {@link FloatingPanel} re-enables pointer events for itself, so the 3D scene
 * stays interactive in the gaps between windows.
 */

import { useViewerStore } from '@/store';
import { getPanelDef, type WorkspacePanelId } from '@/lib/panels/registry';
import { usePanelControls } from '@/hooks/usePanelControls';
import { FloatingPanel } from './FloatingPanel';
import { PropertiesPanel } from '../PropertiesPanel';
import { ComparePanel } from '../ComparePanel';
import { BCFPanel } from '../BCFPanel';
import { IDSPanel } from '../IDSPanel';
import { LensPanel } from '../LensPanel';
import { ClashPanel } from '../ClashPanel';
import { ExtensionsPanel } from '@/components/extensions/ExtensionsPanel';

const FLOAT_Z_BASE = 30;

function renderPanelBody(id: WorkspacePanelId, onClose: () => void) {
  switch (id) {
    case 'properties': return <PropertiesPanel />;
    case 'compare': return <ComparePanel onClose={onClose} />;
    case 'bcf': return <BCFPanel onClose={onClose} />;
    case 'ids': return <IDSPanel onClose={onClose} />;
    case 'lens': return <LensPanel onClose={onClose} />;
    case 'clash': return <ClashPanel onClose={onClose} />;
    case 'extensions': return <ExtensionsPanel onClose={onClose} />;
  }
}

export function FloatingPanelHost() {
  const floatingPanels = useViewerStore((s) => s.floatingPanels);
  const setFloatingPanelRect = useViewerStore((s) => s.setFloatingPanelRect);
  const snapFloatingPanel = useViewerStore((s) => s.snapFloatingPanel);
  const bringFloatingPanelToFront = useViewerStore((s) => s.bringFloatingPanelToFront);
  const { closePanel, dockPanel } = usePanelControls();

  if (floatingPanels.length === 0) return null;

  return (
    <div className="absolute inset-0 z-30 pointer-events-none">
      {floatingPanels.map((panel, i) => {
        const def = getPanelDef(panel.id);
        return (
          <FloatingPanel
            key={panel.id}
            panel={panel}
            title={def?.title ?? panel.id}
            zIndex={FLOAT_Z_BASE + i}
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
