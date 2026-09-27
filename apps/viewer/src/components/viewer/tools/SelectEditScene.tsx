/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GizmoOverlay } from './GizmoOverlay';
import { WallEndpointOverlay } from './WallEndpointOverlay';

/**
 * The Select tool's scene layer (`TOOL_HUD.select.Scene`): the move gizmo
 * plus wall-endpoint handles while edit mode is on. Both overlays self-gate
 * (return null when their conditions aren't met), so always rendering them
 * here is safe. Wall handles render on top of the gizmo so a wall selection
 * gets both axis arrows for translate AND endpoint drag handles for resize;
 * they don't overlap visually (gizmo at bbox centre, handles at start/end).
 */
export function SelectEditScene() {
  return (
    <>
      <GizmoOverlay />
      <WallEndpointOverlay />
    </>
  );
}
