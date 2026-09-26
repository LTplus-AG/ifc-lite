/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The active reasons a viewer can look incomplete, in registry order (#5882). */
import { EyeOff, RotateCcw, X } from 'lucide-react';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from '@/i18n';
import { activeVisibilityReasons, hiddenTypeToggles, resetVisibilityReasons, type VisibilityReason } from '@/lib/visibility/visibility-reasons';
import { useViewerStore, type ViewerState } from '@/store';
import { HudChip } from './HudChip';
import { HudItem } from './HudItem';

function reasonCounts(state: ViewerState) {
  const hiddenModels = [...state.models.values()].filter((model) => !model.visible).length;
  let manuallyHidden = 0;
  for (const id of state.hiddenEntities) {
    if (!state.activeLensId || !state.lensHiddenIds.has(id)) manuallyHidden++;
  }
  return {
    manuallyHidden,
    isolated: state.isolatedEntities?.size ?? 0,
    ghost: state.ghostExceptEntities?.size ?? 0,
    classFilter: state.classFilter?.ids.size ?? 0,
    storeys: state.selectedStoreys.size,
    explodedGap: state.explodedGap,
    hiddenModels,
    totalModels: state.models.size,
    hiddenTypes: hiddenTypeToggles(state.typeVisibility).length,
    hostTypes: state.hostHiddenIfcTypes?.size ?? 0,
    levelDisplayMode: state.levelDisplayMode,
  };
}

export function VisibilityChips() {
  const { t } = useTranslation();
  // Camera and pointer updates also reach the viewer store. Subscribe only to
  // the fields the reason table reads, so large hidden-id sets are scanned
  // when visibility changes rather than on every unrelated store update.
  const visibilityInputs = useViewerStore(useShallow((s) => ({
    hiddenEntities: s.hiddenEntities,
    isolatedEntities: s.isolatedEntities,
    ghostExceptEntities: s.ghostExceptEntities,
    classFilter: s.classFilter,
    selectedStoreys: s.selectedStoreys,
    levelDisplayMode: s.levelDisplayMode,
    explodedGap: s.explodedGap,
    models: s.models,
    activeLensId: s.activeLensId,
    lensHiddenIds: s.lensHiddenIds,
    typeVisibility: s.typeVisibility,
    typeViewMode: s.typeViewMode,
    hasTypeGeometry: s.hasTypeGeometry,
    hostHiddenIfcTypes: s.hostHiddenIfcTypes,
  })));
  const { reasons, counts } = useMemo(() => {
    const state = useViewerStore.getState();
    // `section` and `measurements` (#5893) already have their own richer
    // chips (`SectionParkedChip`, `MeasurementsVisibilityChip`: a visibility
    // toggle plus resume/clear, not just clear) — showing them here too
    // would duplicate the same reason as two chips with different actions.
    // They stay in the registry (Show all / Home / "Reset everything" below
    // still cover them via `resetVisibilityReasons`), just not in this list.
    const reasons = activeVisibilityReasons(state).filter((r) => r.id !== 'section' && r.id !== 'measurements');
    return { reasons, counts: reasonCounts(state) };
  }, [visibilityInputs]);

  if (reasons.length === 0) return null;

  function label(reason: VisibilityReason): string {
    switch (reason.id) {
      case 'hidden': return t('visibilityChips.hiddenCount', { count: counts.manuallyHidden });
      case 'isolation': return t('visibilityChips.isolationCount', { count: counts.isolated });
      case 'ghost': return t('visibilityChips.ghostCount', { count: counts.ghost });
      case 'classFilter': return t('visibilityChips.classFilterCount', { count: counts.classFilter });
      case 'storey': {
        if (counts.levelDisplayMode !== 'solo') return t('visibilityChips.storeyCount', { count: counts.storeys });
        const count = Math.max(1, counts.storeys);
        return t(count === 1 ? 'visibilityChips.soloCount' : 'visibilityChips.soloCountPlural', { count });
      }
      case 'exploded': return t('visibilityChips.explodedGap', { gap: counts.explodedGap });
      case 'modelHidden': return t(
        counts.totalModels === 1 ? 'visibilityChips.modelHiddenSingleCount' : 'visibilityChips.modelHiddenCount',
        { hidden: counts.hiddenModels, total: counts.totalModels },
      );
      case 'typeVisibility': return t('visibilityChips.typeVisibilityCount', { count: counts.hiddenTypes });
      case 'hostTypes': return t('visibilityChips.hostTypesCount', { count: counts.hostTypes });
      default: return t(reason.labelKey);
    }
  }

  return (
    <HudItem region="top-left" order={1} className="flex flex-col items-start gap-2">
      {reasons.map((reason) => {
        const text = label(reason);
        const kept = reason.resetPolicy === 'kept';
        return (
          <div
            key={reason.id}
            data-visibility-reason={reason.id}
            title={kept ? t('visibilityChips.keptTooltip') : text}
          >
            <HudChip
              icon={<EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
              dismiss={kept ? undefined : {
                onClick: () => reason.clear(useViewerStore),
                'aria-label': t('visibilityChips.clearAriaLabel', { reason: text }),
                icon: <X className="h-3 w-3" />,
              }}
            >
              {text}
            </HudChip>
          </div>
        );
      })}
      {reasons.length >= 2 && (
        <HudChip icon={<RotateCcw className="h-3.5 w-3.5" />}>
          <button
            type="button"
            onClick={() => resetVisibilityReasons(useViewerStore)}
            className="text-left"
          >
            {t('visibilityChips.resetEverything')}
          </button>
        </HudChip>
      )}
    </HudItem>
  );
}
