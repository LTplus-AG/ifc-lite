/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { ClashFocusMode } from '@/hooks/useClash';
import { useBCF } from '@/hooks/useBCF';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import {
  defaultManualClashGroupName,
  loadManualClashGroups,
  manualClashMember,
  removeResolvedManualClashMember,
  resolveManualClashGroups,
  saveManualClashGroups,
  type ManualClashGroup,
} from '@/lib/clash/manual-groups';
import {
  focusedCameraViewpointIsCurrent,
  focusedSceneRevisionIsCurrent,
  type FocusedClashGroup,
} from '@/lib/clash/group-focus';
import { CLASH_COLOR_A, CLASH_COLOR_B, clashColorToBcfArgb } from '@/lib/clash/clash-colors';
import { createBCFProject, createBCFTopic } from '@ifc-lite/bcf';
import { sortClashes, type Clash, type ClashSeverity, type ClashSortBy } from '@ifc-lite/clash';
import { useTranslation } from '@/i18n';

const SEVERITY_ORDER: ClashSeverity[] = ['critical', 'major', 'minor', 'info'];
const SEVERITY_COLOR: Record<ClashSeverity, string> = {
  critical: '#f7768e', major: '#ff9e64', minor: '#e0af68', info: '#7aa2f7',
};

export interface ManualClashSection {
  key: string;
  label: string;
  color?: string;
  items: Clash[];
  manualGroupId?: string;
}

export type ManualGroupDialog =
  | { mode: 'create'; initialName: string }
  | { mode: 'rename'; initialName: string; groupId: string }
  | { mode: 'addToGroup'; groupId: string };

export interface DialogProps {
  initialName: string;
  memberCount: number;
}

interface UseManualClashGroupsOptions {
  clashes: readonly Clash[] | undefined;
  visibleClashes: readonly Clash[];
  sortBy: ClashSortBy;
  focusMode: ClashFocusMode;
  focusClashes: (clashes: readonly Clash[], mode: ClashFocusMode) => FocusedClashGroup | null;
  creatingTopic: boolean;
  setCreatingTopic: Dispatch<SetStateAction<boolean>>;
  showGroups: () => void;
}

function getDialogProps(dialog: ManualGroupDialog | null, selectedCount: number, sections: ManualClashSection[]): DialogProps {
  if (!dialog) return { initialName: '', memberCount: 0 };
  if (dialog.mode === 'create') return { initialName: dialog.initialName, memberCount: selectedCount };
  if (dialog.mode === 'rename') return { initialName: dialog.initialName, memberCount: 0 };
  const group = sections.find((s) => s.manualGroupId === dialog.groupId);
  return { initialName: group?.label ?? '', memberCount: selectedCount };
}

export function useManualClashGroups({
  clashes,
  visibleClashes,
  sortBy,
  focusMode,
  focusClashes,
  creatingTopic,
  setCreatingTopic,
  showGroups,
}: UseManualClashGroupsOptions) {
  const [definitions, setDefinitions] = useState<ManualClashGroup[]>(loadManualClashGroups);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<ManualGroupDialog | null>(null);
  const { createViewpointFromState, headerFilesForViewpoints } = useBCF();
  const bcfAuthor = useViewerStore((state) => state.bcfAuthor);
  const setBcfProject = useViewerStore((state) => state.setBcfProject);
  const addTopic = useViewerStore((state) => state.addTopic);
  const addViewpoint = useViewerStore((state) => state.addViewpoint);
  const setBcfPanelVisible = useViewerStore((state) => state.setBcfPanelVisible);
  const { t } = useTranslation();

  useEffect(() => setCheckedIds(new Set()), [clashes]);

  const resolved = useMemo(
    () => resolveManualClashGroups(definitions, clashes ?? []),
    [definitions, clashes],
  );
  const sections = useMemo<ManualClashSection[]>(() => {
    const visibleIds = new Set(visibleClashes.map((clash) => clash.id));
    const groupedIds = new Set(resolved.flatMap((group) => group.members.map((member) => member.id)));
    const grouped = resolved
      .map(({ definition, members }) => {
        const items = sortClashes(members.filter((member) => visibleIds.has(member.id)), sortBy);
        const severity = items.reduce<ClashSeverity>(
          (best, item) => SEVERITY_ORDER.indexOf(item.severity) < SEVERITY_ORDER.indexOf(best) ? item.severity : best,
          'info',
        );
        return {
          key: definition.id,
          label: definition.name,
          color: SEVERITY_COLOR[severity],
          items,
          manualGroupId: definition.id,
        };
      })
      .filter((section) => section.items.length > 0);
    const ungrouped = visibleClashes.filter((clash) => !groupedIds.has(clash.id));
    return ungrouped.length > 0
      ? [...grouped, { key: 'manual-ungrouped', label: 'Ungrouped', items: [...ungrouped] }]
      : grouped;
  }, [resolved, visibleClashes, sortBy]);
  const membersById = useMemo(
    () => new Map(resolved.map((group) => [group.definition.id, group.members])),
    [resolved],
  );
  const selected = useMemo(
    () => (clashes ?? []).filter((clash) => checkedIds.has(clash.id)),
    [clashes, checkedIds],
  );

  const commit = useCallback((next: ManualClashGroup[]): boolean => {
    const saved = saveManualClashGroups(next);
    if (!saved.ok) {
      toast.error(saved.message);
      return false;
    }
    setDefinitions(next);
    return true;
  }, []);

  const openCreate = useCallback((): void => {
    if (selected.length < 2) return;
    const claimed = new Set(resolved.flatMap((group) => group.members.map((member) => member.id)));
    if (selected.some((clash) => claimed.has(clash.id))) {
      toast.error('Remove already-grouped clashes from their current group before regrouping them.');
      return;
    }
    setDialog({
      mode: 'create',
      initialName: defaultManualClashGroupName(selected, definitions.length + 1),
    });
  }, [selected, definitions, resolved]);

  const openAddToGroup = useCallback((groupId: string): void => {
    if (selected.length === 0) return;
    const claimed = new Set(resolved.flatMap((group) => group.members.map((member) => member.id)));
    if (selected.some((clash) => claimed.has(clash.id))) {
      toast.error(t('clashGroups.alreadyGroupedError'));
      return;
    }
    setDialog({ mode: 'addToGroup', groupId });
  }, [selected, resolved]);

  const submitDialog = useCallback((name: string): boolean => {
    if (!dialog) return false;
    if (dialog.mode === 'rename') {
      return commit(definitions.map((group) => group.id === dialog.groupId ? { ...group, name } : group));
    }
    if (dialog.mode === 'addToGroup') {
      const next = definitions.map((group) => group.id === dialog.groupId
        ? { ...group, members: [...group.members, ...selected.map(manualClashMember)] }
        : group);
      if (commit(next)) {
        setCheckedIds(new Set());
        showGroups();
        return true;
      }
      return false;
    }
    const next = [...definitions, {
      id: `manual-${crypto.randomUUID()}`,
      name,
      members: selected.map(manualClashMember),
    }];
    if (commit(next)) {
      setCheckedIds(new Set());
      showGroups();
      return true;
    }
    return false;
  }, [dialog, definitions, selected, commit, showGroups]);

  const removeGroup = useCallback((groupId: string): void => {
    commit(definitions.filter((group) => group.id !== groupId));
  }, [definitions, commit]);

  const removeMember = useCallback((groupId: string, clash: Clash): void => {
    commit(removeResolvedManualClashMember(definitions, resolved, groupId, clash));
  }, [definitions, resolved, commit]);

  const createBcfTopic = useCallback(async (groupId: string): Promise<void> => {
    if (creatingTopic) return;
    const group = resolved.find((item) => item.definition.id === groupId);
    if (!group || group.members.length === 0) return;
    setCreatingTopic(true);
    try {
      // Ghosting is a viewer-only presentation channel that BCF cannot replay.
      // Capture the same A/B colors without the non-serializable context fade.
      const captureMode = focusMode === 'ghost' ? 'highlight' : focusMode;
      const focused = focusClashes(group.members, captureMode);
      if (!focused) {
        toast.error('None of this group’s objects are available in the loaded models.');
        return;
      }
      const topic = createBCFTopic({
        title: group.definition.name,
        description: `${group.members.length} manually grouped clash${group.members.length === 1 ? '' : 'es'}.`,
        author: bcfAuthor,
        topicType: 'Clash',
        topicStatus: 'Open',
      });
      const framedCamera = await focused.frameReady;
      // FRAME-WAIT-ALLOW(#2385): paint the final animated camera pose before capture.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const captureIsCurrent = (): boolean => focusedSceneRevisionIsCurrent(focused)
        && focusedCameraViewpointIsCurrent(framedCamera);
      if (!captureIsCurrent()) {
        toast.error('The loaded models changed while the BCF viewpoint was being captured. Try again.');
        return;
      }
      let visibilityModelIds: readonly string[] = [];
      const viewpoint = await createViewpointFromState({
        includeSnapshot: true,
        includeSelection: false,
        includeHidden: true,
        isCaptureStillValid: captureIsCurrent,
        onVisibilityModelIdsCaptured: (modelIds) => { visibilityModelIds = modelIds; },
        additionalSelectedGuids: focused.selectedGuids,
        additionalColoredGuids: [
          { color: clashColorToBcfArgb(CLASH_COLOR_A), guids: focused.aGuids },
          { color: clashColorToBcfArgb(CLASH_COLOR_B), guids: focused.bGuids },
        ].filter((entry) => entry.guids.length > 0),
        additionalVisibleGuids: focusMode === 'isolate' ? focused.visibleGuids : undefined,
      });
      if (!captureIsCurrent()) {
        toast.error('The loaded models changed while the BCF viewpoint was being captured. Try again.');
        return;
      }
      if (!useViewerStore.getState().bcfProject) {
        setBcfProject(createBCFProject({ name: 'Clash report' }));
      }
      const header = headerFilesForViewpoints(
        viewpoint ? [viewpoint] : [],
        topic.creationDate,
        [...focused.modelIds, ...visibilityModelIds],
      );
      if (header.length > 0) topic.header = header;
      addTopic(topic);
      if (viewpoint) addViewpoint(topic.guid, viewpoint);
      toast.success(t('clashTools.bcfTopic.created'), { label: t('clashTools.bcfTopic.open'), onClick: () => setBcfPanelVisible(true) });
    } catch (error) {
      console.error('[clash] Manual-group BCF topic creation failed:', error);
      toast.error('Could not create a BCF topic for this clash group.');
    } finally {
      setCreatingTopic(false);
    }
  }, [creatingTopic, resolved, setCreatingTopic, focusClashes, focusMode, setBcfProject,
    bcfAuthor, createViewpointFromState, headerFilesForViewpoints, addTopic, addViewpoint, setBcfPanelVisible, t]);

  const dialogProps = useMemo(
    () => getDialogProps(dialog, selected.length, sections),
    [dialog, selected.length, sections],
  );

  return {
    sections,
    groupCount: sections.filter((section) => section.manualGroupId).length,
    membersById,
    selected,
    checkedIds,
    setCheckedIds,
    dialog,
    setDialog,
    dialogProps,
    openCreate,
    openAddToGroup,
    submitDialog,
    removeGroup,
    removeMember,
    createBcfTopic,
  };
}
