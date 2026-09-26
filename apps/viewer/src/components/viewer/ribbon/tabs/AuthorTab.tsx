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

import { Extension, SpaceSketch, AddElement, EditElement, EditProperty, ImportData, Undo, Redo, Appearance } from '@/icons';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { useTranslation } from '@/i18n';
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

/** Latched state shared by the authoring toggles: the interaction accent
 *  (overlay token, #5483), not a mode-specific hue, so edit mode reads the
 *  same in the ribbon, the classic toolbar and over the model (#5489). */
const EDIT_ACTIVE_CLASS = 'bg-overlay-accent-soft text-foreground ring-1 ring-inset ring-overlay-accent/50';

export function AuthorTab() {
  const { t } = useTranslation();
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

  const { activeWorkspacePanels, handleToggleRightPanel } = useWorkspacePanelControls('ribbon');

  return (
    <>
      <RibbonGroup label={t('ribbon.author.editGroup')}>
        <RibbonLargeButton
          icon={EditElement}
          label={t('ribbon.author.editMode')}
          tooltip={canEditInSession
            ? (editEnabled ? t('ribbon.author.exitEditTooltip') : t('ribbon.author.enterEditTooltip'))
            : t('ribbon.author.editLockedTooltip')}
          shortcut="E"
          active={editEnabled}
          activeClassName={EDIT_ACTIVE_CLASS}
          disabled={!canEditInSession}
          onClick={toggleEditEnabled}
        />
        <RibbonSmallStack>
          <RibbonSmallButton
            icon={Undo}
            label={t('ribbon.author.undo')}
            shortcut="⌘Z"
            disabled={!canUndo}
            onClick={() => { replayWorkspaceHistory(useViewerStore.getState(), 'undo'); }}
          />
          <RibbonSmallButton
            icon={Redo}
            label={t('ribbon.author.redo')}
            shortcut="⌘⇧Z"
            disabled={!canRedo}
            onClick={() => { replayWorkspaceHistory(useViewerStore.getState(), 'redo'); }}
          />
        </RibbonSmallStack>
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.author.createGroup')}>
        <RibbonLargeButton
          icon={Appearance}
          label={t('ribbon.author.appearance')}
          className="w-20"
          tooltip={t('ribbon.author.appearanceTooltip')}
          active={activeWorkspacePanels.has('appearance')}
          activeClassName={EDIT_ACTIVE_CLASS}
          onClick={() => handleToggleRightPanel('appearance')}
        />
        <RibbonLargeButton
          icon={AddElement}
          label={t('ribbon.author.addElement')}
          tooltip={t('ribbon.author.addElementTooltip')}
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
          label={t('ribbon.author.spaceSketch')}
          active={activeTool === 'spaceSketch'}
          activeClassName={EDIT_ACTIVE_CLASS}
          disabled={!canEditInSession}
          onClick={() => setActiveTool('spaceSketch')}
          {...tourAnchor(toolAnchor('spaceSketch'))}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.author.propertiesGroup')}>
        <RibbonSmallStack>
          <BulkPropertyEditor
            trigger={
              <RibbonSmallButton
                icon={EditProperty}
                label={t('ribbon.author.bulkPropertyEditor')}
                disabled={!ifcDataStore}
              />
            }
          />
          <DataConnector
            trigger={
              <RibbonSmallButton
                icon={ImportData}
                label={t('ribbon.author.importData')}
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
      <RibbonGroup label={t('ribbon.author.customizeGroup')}>
        <RibbonLargeButton
          icon={Extension}
          label={t('ribbon.author.extensions')}
          tooltip={t('ribbon.author.extensionsTooltip')}
          active={activeWorkspacePanels.has('extensions')}
          onClick={() => handleToggleRightPanel('extensions')}
        />
      </RibbonGroup>
    </>
  );
}
