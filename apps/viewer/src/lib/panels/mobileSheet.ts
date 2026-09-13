/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the mobile bottom sheet is showing right now.
 *
 * Mobile hosts ONE panel at a time, and three things need the answer: the
 * header title, the body, and what the close button should close. Those were
 * three separate if-chains in `ViewerLayout`, and they drifted — the close
 * chain closed the underlying sidebar panel even when an analysis extension or
 * the Add Element tool owned the sheet, so dismissing Add Element also closed
 * whatever panel was behind it. One resolver, three readers.
 *
 * `addElement` is a TOOL and analysis extensions are contributed surfaces, so
 * neither is a registry panel; only the `panel` case carries an id that
 * `renderPanelBody` and the registry understand.
 */

import type { WorkspacePanelId } from './registry';
import type { BottomPanelId } from './bottom-panels';

export type MobileSheetContent =
  | { kind: 'extension' }
  | { kind: 'addElement' }
  | { kind: 'panel'; id: WorkspacePanelId };

export interface MobileSheetInput {
  /** An analysis extension currently owns the slot (either placement). */
  hasAnalysisExtension: boolean;
  activeTool: string;
  /** The bottom-strip panel whose flag is on (`activeBottomPanel`), if any. */
  bottomPanel: BottomPanelId | null;
  /** The single side panel the sidebar considers docked. */
  sidebarActivePanel: WorkspacePanelId;
}

/**
 * Resolve the sheet's occupant. Precedence matches the desktop layout: a
 * contributed extension wins the slot, then the Add Element tool, then the
 * bottom-strip panels, then whichever side panel owns the dock.
 */
export function resolveMobileSheet(input: MobileSheetInput): MobileSheetContent {
  if (input.hasAnalysisExtension) return { kind: 'extension' };
  if (input.activeTool === 'addElement') return { kind: 'addElement' };
  if (input.bottomPanel) return { kind: 'panel', id: input.bottomPanel };
  return { kind: 'panel', id: input.sidebarActivePanel };
}
