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
import { HudHint, HudItem, HudToolbar } from '../../../viewport-ui/hud';
import { useCommandRuntime } from '@/lib/commands/modeling/runtime';
import { CommandFieldsBar } from './CommandFieldsBar';

export function CommandBar() {
  const { t } = useTranslation();
  const { command, ctx, gesture } = useCommandRuntime();
  const endCommand = useViewerStore((s) => s.endCommand);
  if (!command || !ctx) return null;
  const Extra = command.hud.Bar;
  const hint = command.hud.hint?.(gesture);
  return (
    <>
      {/* One row: a narrow lane (Model rail + sidebar open) would otherwise wrap ✕ alone. */}
      <HudToolbar data-command-id={command.id} className="flex-nowrap">
        <span className="px-1.5 text-2xs font-medium uppercase tracking-wide text-overlay-ink-muted">
          {t(command.labelKey)}
        </span>
        <CommandFieldsBar />
        {Extra && <Extra gesture={gesture} ctx={ctx} />}
        <button
          type="button"
          onClick={() => endCommand('cancel')}
          aria-label={t('modelingCommand.closeAria')}
          title={t('modelingCommand.closeAria')}
          className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      </HudToolbar>
      {hint && (
        <HudItem region="bottom-center" order={0}>
          <HudHint>{t(hint)}</HudHint>
        </HudItem>
      )}
    </>
  );
}

export function CommandScene() {
  const { command, ctx, gesture } = useCommandRuntime();
  // The command's preview meshes ride the `command` overlay channel.
  useEffect(() => {
    const callbacks = useViewerStore.getState().cameraCallbacks;
    const meshes = command?.ghost && ctx ? command.ghost(gesture, ctx) : [];
    callbacks.setAuthoringOverlayMeshes?.('command', meshes);
  }, [command, ctx, gesture]);
  useEffect(() => () => useViewerStore.getState().cameraCallbacks.clearAuthoringOverlayMeshes?.('command'), []);
  const Scene = command?.hud.Scene;
  if (!Scene || !ctx) return null;
  return <Scene gesture={gesture} ctx={ctx} />;
}
