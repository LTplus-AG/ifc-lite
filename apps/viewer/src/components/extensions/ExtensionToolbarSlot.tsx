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

import { useMemo } from 'react';
import type { ToolbarContribution } from '@ifc-lite/extensions';
import { evaluateWhen, parseWhen } from '@ifc-lite/extensions';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { useSlotContributions } from '@/hooks/useSlotContributions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';

interface ExtensionToolbarSlotProps {
  slot: 'toolbar.left' | 'toolbar.right' | 'toolbar.center';
}

export function ExtensionToolbarSlot({ slot }: ExtensionToolbarSlotProps) {
  const host = useOptionalExtensionHost();
  const contributions = useSlotContributions<ToolbarContribution>(slot);

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

  const handleClick = (commandId: string) => {
    void host.dispatcher
      .fire(`onCommand:${commandId}` as `onCommand:${string}`)
      .then(() => host.runCommand(commandId))
      .catch((err) => {
        toast.error(`Failed to run "${commandId}": ${err instanceof Error ? err.message : String(err)}`);
      });
  };

  return (
    <div className="flex items-center gap-1">
      {visible.map((c) => {
        const cmd = c.payload.command;
        return (
          <Tooltip key={`${c.extensionId}:${cmd}`}>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => handleClick(cmd)}
                aria-label={`Run extension command ${cmd}`}
              >
                <Sparkles className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{cmd}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
