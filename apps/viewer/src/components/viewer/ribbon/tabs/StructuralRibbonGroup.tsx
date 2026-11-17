/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon · View › Structural (#10604): the structural view mode as three
 * pressed-state buttons, the supports & loads layer, and Derive. It lives on
 * View because mode and glyphs are view state; Derive sits beside them so a
 * model with no analytical data shows the way to create one. Each control is
 * aria-disabled with the palette's reason, so the ribbon and the palette
 * explain an unavailable command the same way.
 */
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { StructuralAnalytical, StructuralBoth, StructuralDerive, StructuralPhysical, StructuralSupports } from '@/icons';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { structuralGlyphsVisible } from '@/lib/visibility/structural-view';
import { paletteAvailability } from '../../palette-availability';
import { surfaceCommand, type SurfaceCommandId } from '../../surface-command-registry';
import { usePersistentToolHosts } from '../../PersistentToolHosts';
import { RibbonGroup, RibbonSmallStack } from '../primitives';
import { RibbonCommandLargeButton, RibbonCommandSmallButton } from '../command-button';

const IDS = ['vis:structural-both', 'vis:structural-analytical', 'vis:structural-physical', 'vis:structuralGlyphs', 'model:derive-structural'] as const;
type StructuralCommandId = typeof IDS[number] & SurfaceCommandId;

/** Why each control cannot run now, or null; the palette's own availability rules. */
function useStructuralBlocks(): Record<StructuralCommandId, TranslationKey | null> {
  const hosts = usePersistentToolHosts();
  // Only the inputs the rules read: camera and pointer updates reach the store too.
  const inputs = useViewerStore(useShallow((s) => [s.models, s.ifcDataStore, s.mutationViews, s.mutationVersion,
    s.structuralViewMode, s.loading, s.collabRole, s.session, s.isMobile]));
  return useMemo(() => {
    const state = useViewerStore.getState();
    const out = {} as Record<StructuralCommandId, TranslationKey | null>;
    for (const id of IDS) {
      const availability = paletteAvailability(surfaceCommand(id, 'ribbon'), { surface: 'ribbon', ...hosts }, state);
      out[id] = availability.status === 'disabled' ? availability.reasonKey : null;
    }
    return out;
  }, [inputs, hosts]);
}

export function StructuralRibbonGroup() {
  const { t } = useTranslation();
  const hosts = usePersistentToolHosts();
  const mode = useViewerStore((s) => s.structuralViewMode ?? 'both');
  const glyphPreference = useViewerStore((s) => s.typeVisibility.structuralGlyphs);
  const blocks = useStructuralBlocks();
  const blockedProps = (id: StructuralCommandId) => {
    const reason = blocks[id];
    return reason ? { 'aria-disabled': true, tooltip: t(reason), 'data-unavailable-reason': reason } : {};
  };
  const glyphsMasked = glyphPreference && mode === 'physical';

  return (
    <RibbonGroup label={t('ribbon.view.structuralGroup')}>
      <RibbonCommandLargeButton
        commandId="model:derive-structural"
        icon={StructuralDerive}
        commandContext={(event) => ({ openStructuralDerivation: () => hosts.openStructuralDerivation?.(event.currentTarget) })}
        {...blockedProps('model:derive-structural')}
      />
      <RibbonSmallStack>
        <RibbonCommandSmallButton commandId="vis:structural-both" icon={StructuralBoth} active={mode === 'both'} {...blockedProps('vis:structural-both')} />
        <RibbonCommandSmallButton commandId="vis:structural-analytical" icon={StructuralAnalytical} active={mode === 'analytical'} {...blockedProps('vis:structural-analytical')} />
        <RibbonCommandSmallButton commandId="vis:structural-physical" icon={StructuralPhysical} active={mode === 'physical'} {...blockedProps('vis:structural-physical')} />
        <RibbonCommandSmallButton
          commandId="vis:structuralGlyphs"
          icon={StructuralSupports}
          active={structuralGlyphsVisible({ structuralGlyphs: glyphPreference }, mode)}
          {...(glyphsMasked ? { tooltip: t('ribbon.view.structuralGlyphsMaskedTooltip') } : {})}
          {...blockedProps('vis:structuralGlyphs')}
        />
      </RibbonSmallStack>
    </RibbonGroup>
  );
}
