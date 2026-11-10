/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ExtensionToolbarSlot` — render extension toolbar contributions.
 *
 * Reads contributions from the slot registry. Each contribution
 * declares a slot (`toolbar.left | toolbar.right | toolbar.center`)
 * and a command id. Clicking dispatches through the host's command
 * runner.
 *
 * Ordering: by `order` ascending; ties broken by command id alpha.
 * Visibility: respects the `when` clause if present (evaluated against
 * a minimal viewer context — model loaded / selection count / etc).
 */

import { useLayoutEffect, useMemo, useRef } from 'react';
import type { ResolvedToolbarContribution } from '@ifc-lite/extensions';
import { evaluateWhen, parseWhen } from '@ifc-lite/extensions';
import { IconButton } from '@/components/ui/icon-button';
import { toast } from '@/components/ui/toast';
import { describeRunCommandError } from '@/services/extensions/runtime-errors';
import { useSlotContributions } from '@/hooks/useSlotContributions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';
import { resolveExtensionIcon } from './icon-registry';
import { useTranslation } from '@/i18n';

interface ExtensionToolbarSlotProps {
  slot: 'toolbar.left' | 'toolbar.right' | 'toolbar.center';
}

export function ExtensionToolbarSlot({ slot }: ExtensionToolbarSlotProps) {
  const { t } = useTranslation();
  const host = useOptionalExtensionHost();
  const currentHost = useRef(host);
  useLayoutEffect(() => {
    currentHost.current = host;
    return () => { currentHost.current = null; };
  }, [host]);
  // Loader enriches the toolbar payload with the linked command's
  // `icon` + `title` — see manifestToContributions in loader.ts.
  const contributions = useSlotContributions<ResolvedToolbarContribution>(slot);

  const models = useViewerStore((s) => s.models);
  const selectedCount = useViewerStore((s) => s.selectedEntityIds.size);

  const whenContext = useMemo(() => ({
    'model.loaded': models.size > 0,
    'model.schema': undefined,
    'model.count': models.size,
    'selection.count': selectedCount,
    'selection.type': undefined,
    'viewer.open': true,
    desktop: false,
    embed: false,
  }), [models.size, selectedCount]);

  const visible = useMemo(() => {
    return contributions
      .filter((c) => {
        const when = c.payload.when;
        if (!when) return true;
        const parsed = parseWhen(when);
        if (!parsed.ok) return false;
        return evaluateWhen(parsed.value, whenContext);
      })
      .sort((a, b) => {
        const oa = a.payload.order ?? 100;
        const ob = b.payload.order ?? 100;
        if (oa !== ob) return oa - ob;
        return a.payload.command.localeCompare(b.payload.command);
      });
  }, [contributions, whenContext]);

  if (visible.length === 0 || !host) return null;

  // `extensionId` is the clicked contribution's own owner. Two installed
  // extensions can declare the same command id (ids are namespaced by
  // convention only), and this slot renders one button per contribution —
  // so the run has to be pinned to the button's extension or the second
  // button silently runs the first extension's handler.
  const handleClick = (contribution: (typeof contributions)[number]) => {
    const { command: commandId } = contribution.payload;
    void host.runCommand(commandId, contribution.extensionId, undefined, () =>
      currentHost.current === host && host.slotRegistry.getAll(slot).includes(contribution))
      .catch((err) => {
        toast.error(describeRunCommandError(commandId, err));
      });
  };

  return (
    <div className="flex items-center gap-1">
      {visible.map((c) => {
        const cmd = c.payload.command;
        const title = c.payload.title ?? cmd;
        const Icon = resolveExtensionIcon(c.payload.icon);
        return (
          <IconButton
            key={`${c.extensionId}:${cmd}`}
            label={t('extensionsFlavors.extensionToolbarSlot.runAriaLabel', { title })}
            tooltip={title}
            onClick={() => handleClick(c)}
          >
            <Icon className="h-4 w-4" />
          </IconButton>
        );
      })}
    </div>
  );
}
