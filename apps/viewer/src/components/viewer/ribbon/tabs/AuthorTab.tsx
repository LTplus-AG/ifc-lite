/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { hasWorkspaceHistory, replayWorkspaceHistory } from '@/lib/model-placement/history';

/**
 * Ribbon · Author tab — the authoring surface: the global edit-mode
 * switch, undo/redo, element creation tools, and bulk property flows.
 * Everything here honors the same collab role gate as the classic
 * toolbar (viewer/commenter roles cannot unlock authoring).
 */

import { Extension, SpaceSketch, AddElement, EditElement, EditProperty, ImportData, Undo, Redo } from '@/icons';
import { Palette } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { tourAnchor, toolAnchor } from '@/lib/tours/anchors';
import { BulkPropertyEditor } from '../../BulkPropertyEditor';
import { DataConnector } from '../../DataConnector';
import { useWorkspacePanelControls } from '../../toolbar/useWorkspacePanelControls';
import {
  RibbonGroup,
  RibbonGroupDivider,
  RibbonLargeButton,
  RibbonSmallButton,
  RibbonSmallStack,
} from '../primitives';

/** Purple latched accent shared by the authoring toggles (matches the
 *  classic toolbar's Edit pill so the mode reads identically). */
const EDIT_ACTIVE_CLASS = 'bg-purple-600/20 text-foreground ring-1 ring-inset ring-purple-600/50';

export function AuthorTab() {
  const { ifcDataStore } = useIfc();
  const activeTool = useViewerStore((state) => state.activeTool);
  const setActiveTool = useViewerStore((state) => state.setActiveTool);
  const editEnabled = useViewerStore((state) => state.editEnabled);
  const toggleEditEnabled = useViewerStore((state) => state.toggleEditEnabled);
  // Collab role: editing is reserved for editor/admin. Derive from the
  // reactive role so the Edit switch enables/disables live when the role
  // changes. null role = single-user, always editable.
  const collabEditRole = useViewerStore((state) => state.collabRole);
  const canEditInSession =
    collabEditRole === null || collabEditRole === 'editor' || collabEditRole === 'admin';

  // Undo/redo replay authoring mutations, so they honour the same collab
  // role gate as edit mode.
  const hasUndo = useViewerStore(state => hasWorkspaceHistory(state, 'undo'));
  const canUndo = canEditInSession && hasUndo;
  const hasRedo = useViewerStore(state => hasWorkspaceHistory(state, 'redo'));
  const canRedo = canEditInSession && hasRedo;

  const { activeWorkspacePanels, handleToggleRightPanel } = useWorkspacePanelControls();

  return (
    <>
      <RibbonGroup label="Edit">
        <RibbonLargeButton
          icon={EditElement}
          label="Edit mode"
          tooltip={canEditInSession
            ? (editEnabled ? 'Exit edit mode' : 'Enter edit mode')
            : 'Editing requires editor access in this shared session'}
          shortcut="E"
          active={editEnabled}
          activeClassName={EDIT_ACTIVE_CLASS}
          disabled={!canEditInSession}
          onClick={toggleEditEnabled}
        />
        <RibbonSmallStack>
          <RibbonSmallButton
            icon={Undo}
            label="Undo"
            shortcut="⌘Z"
            disabled={!canUndo}
            onClick={() => { replayWorkspaceHistory(useViewerStore.getState(), 'undo'); }}
          />
          <RibbonSmallButton
            icon={Redo}
            label="Redo"
            shortcut="⌘⇧Z"
            disabled={!canRedo}
            onClick={() => { replayWorkspaceHistory(useViewerStore.getState(), 'redo'); }}
          />
        </RibbonSmallStack>
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label="Create">
        <RibbonLargeButton
          icon={Palette}
          label="Appearance"
          className="w-20"
          tooltip="Appearance: apply images across IFC surfaces"
          active={activeWorkspacePanels.has('appearance')}
          activeClassName={EDIT_ACTIVE_CLASS}
          onClick={() => handleToggleRightPanel('appearance')}
        />
        <RibbonLargeButton
          icon={AddElement}
          label="Add element"
          tooltip="Add element (opens the drawing panel)"
          active={activeWorkspacePanels.has('addElement')}
          activeClassName={EDIT_ACTIVE_CLASS}
          disabled={!canEditInSession}
          onClick={() => handleToggleRightPanel('addElement')}
        />
        {/* Space Sketch bakes IfcSpace entities; picking it flips edit
            mode on via the AUTHORING_TOOLS rule in uiSlice, so it can
            stay visible (not hidden behind edit mode like the classic
            toolbar) — the ribbon has room for stable geography. */}
        <RibbonLargeButton
          icon={SpaceSketch}
          label="Space Sketch"
          active={activeTool === 'spaceSketch'}
          activeClassName={EDIT_ACTIVE_CLASS}
          disabled={!canEditInSession}
          onClick={() => setActiveTool('spaceSketch')}
          {...tourAnchor(toolAnchor('spaceSketch'))}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label="Properties">
        <RibbonSmallStack>
          <BulkPropertyEditor
            trigger={
              <RibbonSmallButton
                icon={EditProperty}
                label="Bulk property editor"
                disabled={!ifcDataStore}
              />
            }
          />
          <DataConnector
            trigger={
              <RibbonSmallButton
                icon={ImportData}
                label="Import data (CSV)"
                disabled={!ifcDataStore}
              />
            }
          />
        </RibbonSmallStack>
      </RibbonGroup>

      <RibbonGroupDivider />

      {/* Extensions & flavors manage the workspace itself — installed
          extensions, personal flavors, permissions. Customization, not
          analysis, so it lives here (mirrors the classic Panels menu,
          which files Extensions under its "Author" section). */}
      <RibbonGroup label="Customize">
        <RibbonLargeButton
          icon={Extension}
          label="Extensions"
          tooltip="Extensions & flavors"
          active={activeWorkspacePanels.has('extensions')}
          onClick={() => handleToggleRightPanel('extensions')}
        />
      </RibbonGroup>
    </>
  );
}
