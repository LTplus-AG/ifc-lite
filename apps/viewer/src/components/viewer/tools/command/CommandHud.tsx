/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `command` row of `TOOL_HUD` (charter #6232, WP2): whatever modeling
 * command is running supplies its bar content, scene layer and hint through
 * `ModelingCommand.hud`; this places them. The bar always names the command,
 * shows its typed fields (`CommandFieldsBar`) and offers a close button for
 * touch users, who have no Escape.
 */

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { HudHint, HudItem, HudToolbar, useHudBarTier } from '../../../viewport-ui/hud';
import { useCommandRuntime } from '@/lib/commands/modeling/runtime';
import { CommandFieldsBar } from './CommandFieldsBar';
import { SnapHud } from './SnapHud';

/** Tier 0: one row. Tier 1 (the fallback, never measured): stacked rows that wrap inside the lane. */
const TIER_ROW = 0;
const TIER_STACKED = 1;
const OFFSCREEN = { position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' } as const;

/**
 * The running command's bar in the top-center lane. One row when it fits
 * (measured offscreen, `useHudBarTier`); otherwise stacked, with the name and
 * close button on the first row so ✕ never wraps alone, and the fields and
 * the command's own controls (Align, Chain, class, …) wrapping under it. A
 * placing command's bar is wide (#6232 M2.2); held on one row it ran out of
 * the lane, under the storey chip and the ViewCube.
 */
export function CommandBar() {
  const { t } = useTranslation();
  const { command, ctx, gesture } = useCommandRuntime();
  const { measureRef, tier } = useHudBarTier(TIER_STACKED);
  if (!command || !ctx) return null;
  const hint = command.hud.hint?.(gesture);
  return (
    <>
      <div ref={measureRef(TIER_ROW)} aria-hidden="true" style={OFFSCREEN}>
        <CommandBarContent tier={TIER_ROW} measuring />
      </div>
      <CommandBarContent tier={tier} />
      {hint && (
        <HudItem region="bottom-center" order={0}>
          <HudHint>{t(hint)}</HudHint>
        </HudItem>
      )}
    </>
  );
}

/**
 * The bar in one form. `measuring` marks the offscreen copy: unwrapped, not
 * tagged with `data-command-id`, and its fields register no handles.
 */
export function CommandBarContent({ tier, measuring = false }: { tier: number; measuring?: boolean }) {
  const { t } = useTranslation();
  const { command, ctx, gesture } = useCommandRuntime();
  const endCommand = useViewerStore((s) => s.endCommand);
  if (!command || !ctx) return null;
  const Extra = command.hud.Bar;
  const label = (
    <span className="px-1.5 text-2xs font-medium uppercase tracking-wide text-overlay-ink-muted">
      {t(command.labelKey)}
    </span>
  );
  const close = (
    <button
      type="button"
      onClick={() => endCommand('cancel')}
      aria-label={t('modelingCommand.closeAria')}
      title={t('modelingCommand.closeAria')}
      tabIndex={measuring ? -1 : undefined}
      className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
    >
      <X aria-hidden className="h-3.5 w-3.5" />
    </button>
  );
  const tag = measuring ? {} : { 'data-command-id': command.id, 'data-bar-tier': tier };
  if (tier === TIER_ROW) {
    return (
      <HudToolbar {...tag} className="flex-nowrap">
        {label}
        <CommandFieldsBar measuring={measuring} />
        {Extra && <Extra gesture={gesture} ctx={ctx} />}
        {close}
      </HudToolbar>
    );
  }
  return (
    <HudToolbar {...tag} className="flex-col items-stretch">
      <div className="flex items-center justify-between gap-1">{label}{close}</div>
      <div className="flex flex-wrap items-center gap-1"><CommandFieldsBar measuring={measuring} /></div>
      {/* A row never starts with the divider that separates it from the fields in the one-row form. */}
      {Extra && <div className="flex flex-wrap items-center gap-1 [&>[aria-hidden]:first-child]:hidden"><Extra gesture={gesture} ctx={ctx} /></div>}
    </HudToolbar>
  );
}

export function CommandScene() {
  const { command, ctx, gesture, snap } = useCommandRuntime();
  // The command's preview meshes ride the `command` overlay channel.
  useEffect(() => {
    const callbacks = useViewerStore.getState().cameraCallbacks;
    const meshes = command?.ghost && ctx ? command.ghost(gesture, ctx) : [];
    callbacks.setAuthoringOverlayMeshes?.('command', meshes);
  }, [command, ctx, gesture]);
  useEffect(() => () => useViewerStore.getState().cameraCallbacks.clearAuthoringOverlayMeshes?.('command'), []);
  const Scene = command?.hud.Scene;
  if (!command || !ctx) return null;
  // Every command shows what it snapped to, above its own scene layer: the snap is the live feedback.
  return (
    <>
      {Scene && <Scene gesture={gesture} ctx={ctx} />}
      <SnapHud snap={snap} plane={ctx.workplane} />
    </>
  );
}
