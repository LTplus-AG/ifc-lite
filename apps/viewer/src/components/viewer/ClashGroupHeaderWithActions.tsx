/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Clash } from '@ifc-lite/clash';
import { ClashGroupHeader } from './ClashManualGroupControls';
import type { ClashFocusMode } from '@/hooks/useClash';
import type { ClashGroupRow } from '@/lib/clash/display-rows';

interface ClashGroupHeaderWithActionsProps {
  section: ClashGroupRow;
  collapsed: boolean;
  creatingTopic: boolean;
  focusMode: ClashFocusMode;
  membersById: Map<string, readonly Clash[]>;
  onToggle: (key: string) => void;
  onFocus: (clashes: readonly Clash[], mode: ClashFocusMode) => void;
  onAddToGroup: (groupId: string) => void;
  onCreateBcf: (groupId: string) => void;
  onRename: (groupId: string, label: string) => void;
  onRemove: (groupId: string) => void;
  showGroups: () => void;
}

export function ClashGroupHeaderWithActions({
  section,
  collapsed,
  creatingTopic,
  focusMode,
  membersById,
  onToggle,
  onFocus,
  onAddToGroup,
  onCreateBcf,
  onRename,
  onRemove,
  showGroups,
}: ClashGroupHeaderWithActionsProps) {
  const handleAddToGroup = section.manualGroupId
    ? (g: string) => (onAddToGroup(g), showGroups())
    : undefined;
  return (
    <ClashGroupHeader
      sectionKey={section.key}
      label={section.label}
      color={section.color}
      count={section.count}
      collapsed={collapsed}
      manualGroupId={section.manualGroupId}
      creatingTopic={creatingTopic}
      onToggle={onToggle}
      onFocus={(groupId) => onFocus(membersById.get(groupId) ?? [], focusMode)}
      onAddToGroup={handleAddToGroup || (() => {})}
      onCreateBcf={onCreateBcf}
      onRename={(groupId) => onRename(groupId, section.label)}
      onRemove={onRemove}
    />
  );
}
