/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { FileBox } from 'lucide-react';
import { useViewerStore } from '@/store';
import { cn } from '@/lib/utils';

/**
 * Compact source-model badge: a FileBox glyph plus the model / file name,
 * resolved from a `modelId` through the federation `models` map. The shared
 * federation-identity chip for panels that surface elements from several loaded
 * models (issue #1591), matching the "Model Source" idiom in the properties
 * panel so every panel reads the same.
 *
 * Renders nothing when the id does not resolve to a loaded model — including
 * the legacy single-model ids (`default` / `legacy`), which are never in the
 * map — so callers can render it unconditionally without leaking a stray badge
 * onto single-model views.
 */
export function ModelBadge({ modelId, className }: { modelId: string; className?: string }) {
  const name = useViewerStore((s) => s.models.get(modelId)?.name);
  if (!name) return null;
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground', className)}
      title={name}
    >
      <FileBox className="h-3 w-3 shrink-0" />
      <span className="truncate font-mono">{name}</span>
    </span>
  );
}
