/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StoreyInventory } from './storey-model.js';
import type { StoreyNotice } from './storey-validation.js';

type ElementType = NonNullable<StoreyNotice['elementType']>;
const LABELS: Record<ElementType, string> = { IfcWall: 'wall', IfcColumn: 'column', IfcBeam: 'beam', IfcMember: 'member', IfcCurtainWall: 'curtain wall' };

/** Keep each attachable kind selectable and translatable, including members. */
export function attachmentNotices(inventory: StoreyInventory, rows: readonly { id: number; problem?: string }[], unresolved: boolean): StoreyNotice[] {
  const groups = new Map<ElementType, Array<{ id: number; problem?: string }>>();
  for (const row of rows) {
    const name = inventory.reader.entity(row.id)?.type.toUpperCase() ?? '';
    const type: ElementType = name.startsWith('IFCCOLUMN') ? 'IfcColumn' : name.startsWith('IFCMEMBER') ? 'IfcMember'
      : name.startsWith('IFCBEAM') ? 'IfcBeam' : name === 'IFCCURTAINWALL' ? 'IfcCurtainWall' : 'IfcWall';
    const group = groups.get(type);
    if (group) group.push(row); else groups.set(type, [row]);
  }
  return [...groups].map(([type, members]) => ({
    code: unresolved ? 'wallAttachmentUnresolved' : type === 'IfcWall' ? 'wallNotResized' : 'attachedNotResized',
    elementIds: members.map(row => row.id),
    ...(type === 'IfcWall' ? {} : { elementType: type }),
    message: unresolved
      ? `${members.length} ${LABELS[type]}(s) record a top attachment that names nothing they can follow, so they keep their height: ${members.map(row => `#${row.id} ${row.problem}`).join('; ')}`
      : type === 'IfcWall' ? `${members.length} attached wall(s) are not simple extrusions, so they move but keep their height`
        : `${members.length} attached ${LABELS[type]}(s) have a body or attachment this editor cannot follow, so they move but keep their height`,
  }));
}
