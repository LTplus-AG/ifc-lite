/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { evaluateWhen, parseWhen, type StatusBarContribution } from '@ifc-lite/extensions';
import { useSlotContributions } from '@/hooks/useSlotContributions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';

export function ExtensionStatusBarSlot({ slot }: { slot: StatusBarContribution['slot'] }) {
  const host = useOptionalExtensionHost();
  const contributions = useSlotContributions<StatusBarContribution>(slot);
  const modelCount = useViewerStore((s) => s.models.size);
  const selectedCount = useViewerStore((s) => s.selectedEntityIds.size);
  const visible = useMemo(() => {
    const context = {
      'model.loaded': modelCount > 0,
      'model.count': modelCount,
      'selection.count': selectedCount,
      'viewer.open': true,
    };
    return contributions
      .filter((contribution) => {
        const when = contribution.payload.when;
        if (!when) return true;
        const parsed = parseWhen(when);
        return parsed.ok && evaluateWhen(parsed.value, context);
      })
      .sort((a, b) => (a.payload.order ?? 100) - (b.payload.order ?? 100));
  }, [contributions, modelCount, selectedCount]);

  if (visible.length === 0) return null;
  return (
    <>
      {visible.map((contribution) => {
        const command = contribution.payload.command;
        const content = <span>{contribution.payload.text}</span>;
        if (!command) {
          return <span key={`${contribution.extensionId}:${contribution.payload.id}`}>{content}</span>;
        }
        return (
          <button
            key={`${contribution.extensionId}:${contribution.payload.id}`}
            type="button"
            className="hover:text-primary"
            onClick={() => {
              void host?.runCommand(command);
            }}
          >
            {content}
          </button>
        );
      })}
    </>
  );
}
