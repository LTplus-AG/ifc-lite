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
  manualClashGroupBcfRefs,
  resolveManualClashGroups,
  saveManualClashGroups,
  type ManualClashGroup,
} from '@/lib/clash/manual-groups';
import { CLASH_COLOR_A, CLASH_COLOR_B, clashColorToBcfArgb } from '@/lib/clash/clash-colors';
import { createBCFProject, createBCFTopic } from '@ifc-lite/bcf';
import { clashReviewKey, sortClashes, type Clash, type ClashSeverity, type ClashSortBy } from '@ifc-lite/clash';

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
  | { mode: 'rename'; initialName: string; groupId: string };

interface UseManualClashGroupsOptions {
  clashes: readonly Clash[] | undefined;
  visibleClashes: readonly Clash[];
  sortBy: ClashSortBy;
  focusMode: ClashFocusMode;
  focusClashes: (clashes: readonly Clash[], mode: ClashFocusMode) => void;
  creatingTopic: boolean;
  setCreatingTopic: Dispatch<SetStateAction<boolean>>;
  showGroups: () => void;
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
  const bcfProject = useViewerStore((state) => state.bcfProject);
  const bcfAuthor = useViewerStore((state) => state.bcfAuthor);
  const setBcfProject = useViewerStore((state) => state.setBcfProject);
  const addTopic = useViewerStore((state) => state.addTopic);
  const addViewpoint = useViewerStore((state) => state.addViewpoint);
  const setBcfPanelVisible = useViewerStore((state) => state.setBcfPanelVisible);

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
    const claimed = new Set(definitions.flatMap((group) => group.clashKeys));
    if (selected.some((clash) => claimed.has(clashReviewKey(clash)))) {
      toast.error('Remove already-grouped clashes from their current group before regrouping them.');
      return;
    }
    setDialog({
      mode: 'create',
      initialName: defaultManualClashGroupName(selected, definitions.length + 1),
    });
  }, [selected, definitions]);

  const submitDialog = useCallback((name: string): void => {
    if (!dialog) return;
    if (dialog.mode === 'rename') {
      commit(definitions.map((group) => group.id === dialog.groupId ? { ...group, name } : group));
      return;
    }
    const next = [...definitions, {
      id: `manual-${crypto.randomUUID()}`,
      name,
      clashKeys: selected.map(clashReviewKey),
    }];
    if (commit(next)) {
      setCheckedIds(new Set());
      showGroups();
    }
  }, [dialog, definitions, selected, commit, showGroups]);

  const removeGroup = useCallback((groupId: string): void => {
    commit(definitions.filter((group) => group.id !== groupId));
  }, [definitions, commit]);

  const removeMember = useCallback((groupId: string, clash: Clash): void => {
    const next = definitions.flatMap((group) => {
      if (group.id !== groupId) return [group];
      const clashKeys = group.clashKeys.filter((key) => key !== clashReviewKey(clash));
      return clashKeys.length > 0 ? [{ ...group, clashKeys }] : [];
    });
    commit(next);
  }, [definitions, commit]);

  const createBcfTopic = useCallback(async (groupId: string): Promise<void> => {
    if (creatingTopic) return;
    const group = resolved.find((item) => item.definition.id === groupId);
    if (!group || group.members.length === 0) return;
    setCreatingTopic(true);
    try {
      focusClashes(group.members, focusMode);
      // FRAME-WAIT-ALLOW(#2385): capture only after the group focus has painted.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!bcfProject) setBcfProject(createBCFProject({ name: 'Clash report' }));
      const topic = createBCFTopic({
        title: group.definition.name,
        description: `${group.members.length} manually grouped clash${group.members.length === 1 ? '' : 'es'}.`,
        author: bcfAuthor,
        topicType: 'Clash',
        topicStatus: 'Open',
      });
      const { selectedRefs, aRefs, bRefs } = manualClashGroupBcfRefs(group.members);
      const viewpoint = await createViewpointFromState({
        includeSnapshot: true,
        includeSelection: true,
        includeHidden: true,
        additionalSelectedRefs: selectedRefs,
        additionalColoredRefs: [
          { color: clashColorToBcfArgb(CLASH_COLOR_A), refs: aRefs },
          { color: clashColorToBcfArgb(CLASH_COLOR_B), refs: bRefs },
        ].filter((entry) => entry.refs.length > 0),
      });
      const header = headerFilesForViewpoints(viewpoint ? [viewpoint] : [], topic.creationDate);
      if (header.length > 0) topic.header = header;
      addTopic(topic);
      if (viewpoint) addViewpoint(topic.guid, viewpoint);
      setBcfPanelVisible(true);
    } catch (error) {
      console.error('[clash] Manual-group BCF topic creation failed:', error);
      toast.error('Could not create a BCF topic for this clash group.');
    } finally {
      setCreatingTopic(false);
    }
  }, [creatingTopic, resolved, setCreatingTopic, focusClashes, focusMode, bcfProject, setBcfProject,
    bcfAuthor, createViewpointFromState, headerFilesForViewpoints, addTopic, addViewpoint, setBcfPanelVisible]);

  return {
    sections,
    groupCount: sections.filter((section) => section.manualGroupId).length,
    membersById,
    selected,
    checkedIds,
    setCheckedIds,
    dialog,
    setDialog,
    openCreate,
    submitDialog,
    removeGroup,
    removeMember,
    createBcfTopic,
  };
}
