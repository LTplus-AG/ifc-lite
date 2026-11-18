/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WorkspacePanelId } from '@/lib/panels/registry';

/**
 * The panels `enforcePanelAvailability` keeps closed, shared with the sidebar
 * exclusivity listener so both read one snapshot and neither asks a feature
 * gate before the viewer configuration is applied. Production sets it at most
 * once, when `applyRuntimeConfig` installs a rule with something switched off.
 */
let off: ReadonlySet<WorkspacePanelId> = new Set();

export function setEnforcedOffPanels(panels: ReadonlySet<WorkspacePanelId>): void {
  off = panels;
}

export function isPanelEnforcedOff(id: WorkspacePanelId): boolean {
  return off.has(id);
}
