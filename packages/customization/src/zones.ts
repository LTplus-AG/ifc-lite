/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BUILTIN_PANEL_IDS, type JsonValue } from '@ifc-lite/extensions';

export interface BuiltInEditableZoneDescriptor {
  panelId: string;
  label: string;
  description: string;
  defaults: JsonValue;
}

export function listBuiltInEditableZones(): BuiltInEditableZoneDescriptor[] {
  return [
    {
      panelId: BUILTIN_PANEL_IDS.properties,
      label: 'Properties panel',
      description: 'Control density, default expansion, and pinned property fields.',
      defaults: { density: 'comfortable', defaultExpanded: ['Identity'], pinnedFields: ['GlobalId', 'Name', 'Type'] },
    },
    {
      panelId: BUILTIN_PANEL_IDS.hierarchy,
      label: 'Hierarchy panel',
      description: 'Control grouping, sort order, and badge display.',
      defaults: { grouping: 'spatial', sort: 'ifc', badges: ['Type'] },
    },
    {
      panelId: 'builtin:toolbar',
      label: 'Toolbar',
      description: 'Control toolbar density and command grouping.',
      defaults: { density: 'compact', groups: ['file', 'tools', 'view', 'extensions'] },
    },
    {
      panelId: 'builtin:status-bar',
      label: 'Status bar',
      description: 'Control visible status segments.',
      defaults: { segments: ['status', 'stats', 'performance', 'flavor', 'version'] },
    },
  ];
}
