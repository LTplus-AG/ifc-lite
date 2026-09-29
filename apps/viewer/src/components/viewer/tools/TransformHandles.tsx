/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's stand-in for the select tool's move gizmo (charter
 * #6232, C2): two handles beside the selection's centre that start
 * `element.move` and `element.rotate` on it. There, a move or turn is a
 * command — snapped, typed, one undo step, hosted fillings carried — for
 * authored and file elements alike, so the free per-axis drag of
 * `GizmoOverlay` (which stays as it is outside the workspace) gives way.
 * Shown for any selection the commands can take, single or multiple.
 */

import { useMemo } from 'react';
import { Move, RotateCw } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { canMutate } from '@/store/mutation-permission';
import { shortcutLabel } from '@/lib/commands/shortcut-label';
import { launchModelCommand } from '@/lib/commands/modeling/keys-workspace';
import { readTransformSelection, selectionRenderCentre } from '@/lib/commands/modeling/commands/element-transform-shared';
import { useProjectorTick } from '@/components/viewport-ui/scene';

/** Screen offset of the handle pair from the selection's centre. */
const OFFSET = { dx: 18, dy: -18 };

export function TransformHandles() {
  const { t } = useTranslation();
  const inWorkspace = useViewerStore((s) => s.workspaceMode === 'model');
  const editEnabled = useViewerStore((s) => s.editEnabled);
  const activeTool = useViewerStore((s) => s.activeTool);
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const selectedEntityIds = useViewerStore((s) => s.selectedEntityIds);
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const geometryUpdateTick = useViewerStore((s) => s.geometryUpdateTick);

  const centre = useMemo(() => {
    if (!inWorkspace || !editEnabled || activeTool !== 'select' || selectedEntityId === null) return null;
    const s = useViewerStore.getState();
    const selection = readTransformSelection(s);
    if (!selection || selection.refusal || !canMutate(s, selection.modelId)) return null;
    return selectionRenderCentre(s, selection);
    // mutationVersion / geometryUpdateTick: the centre follows edits and re-meshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inWorkspace, editEnabled, activeTool, selectedEntityId, selectedEntityIds, mutationVersion, geometryUpdateTick]);

  void useProjectorTick(centre !== null);
  if (!centre || !projectToScreen) return null;
  const at = projectToScreen({ x: centre[0], y: centre[1], z: centre[2] });
  if (!at) return null;

  const handle = (id: 'element.move' | 'element.rotate', Icon: typeof Move, label: string, dx: number) => (
    <button
      type="button"
      data-transform-handle={id}
      aria-label={label}
      title={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); launchModelCommand(id); }}
      className="pointer-events-auto absolute flex h-7 w-7 items-center justify-center rounded-full border border-overlay-accent bg-overlay-halo text-overlay-accent shadow-sm hover:bg-overlay-accent hover:text-overlay-halo"
      style={{ left: at.x + OFFSET.dx + dx, top: at.y + OFFSET.dy, transform: 'translate(-50%, -50%)' }}
    >
      <Icon aria-hidden className="h-3.5 w-3.5" />
    </button>
  );

  return (
    <div className="absolute inset-0 pointer-events-none z-30" data-transform-handles>
      {handle('element.move', Move, t('moveRotate.handle.move', { key: shortcutLabel('model.move') }), 0)}
      {handle('element.rotate', RotateCw, t('moveRotate.handle.rotate', { key: shortcutLabel('model.rotate') }), 32)}
    </div>
  );
}
