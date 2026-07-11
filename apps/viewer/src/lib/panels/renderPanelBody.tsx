/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Single id → panel-component map (#1208 follow-up).
 *
 * The unified sidebar, the floating-panel host (#1201) and the pop-out
 * windows all need to render the *same* panel body for a given id. Keeping
 * the switch here means a panel only has to be wired once, and the three
 * hosts stay in lock-step.
 */

import type { ReactNode } from 'react';
import type { WorkspacePanelId } from './registry';
import { HierarchyPanel } from '@/components/viewer/HierarchyPanel';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { ComparePanel } from '@/components/viewer/ComparePanel';
import { BCFPanel } from '@/components/viewer/BCFPanel';
import { IDSPanel } from '@/components/viewer/IDSPanel';
import { LensPanel } from '@/components/viewer/LensPanel';
import { ClashPanel } from '@/components/viewer/ClashPanel';
import { ExtensionsPanel } from '@/components/extensions/ExtensionsPanel';
import { ScriptPanel } from '@/components/viewer/ScriptPanel';
import { GanttPanel } from '@/components/viewer/schedule/GanttPanel';
import { ListPanel } from '@/components/viewer/lists/ListPanel';
import { RoomPanel } from '@/components/viewer/RoomPanel';
import { LayersPanel } from '@/components/viewer/layers/LayersPanel';

/**
 * Render the body for a workspace panel. `onClose` is the host's "close this
 * panel" handler (re-dock to Information, remove the float, or re-dock the
 * window). The Information panel ignores it — it is the always-on fallback.
 */
export function renderPanelBody(id: WorkspacePanelId, onClose: () => void): ReactNode {
  switch (id) {
    // Hierarchy's home is the left slot (#1267); it is never routed to the right
    // pane / float / pop-out, but the case keeps the id to body map exhaustive.
    case 'hierarchy': return <HierarchyPanel />;
    case 'properties': return <PropertiesPanel />;
    case 'compare': return <ComparePanel onClose={onClose} />;
    case 'bcf': return <BCFPanel onClose={onClose} />;
    case 'ids': return <IDSPanel onClose={onClose} />;
    case 'lens': return <LensPanel onClose={onClose} />;
    case 'clash': return <ClashPanel onClose={onClose} />;
    case 'extensions': return <ExtensionsPanel onClose={onClose} />;
    case 'script': return <ScriptPanel onClose={onClose} />;
    case 'gantt': return <GanttPanel onClose={onClose} />;
    case 'lists': return <ListPanel onClose={onClose} />;
    case 'collab': return <RoomPanel onClose={onClose} />;
    case 'layers': return <LayersPanel onClose={onClose} />;
  }
}
