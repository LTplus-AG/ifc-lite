/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Create BCF issue" affordance shown under the focused change (issue #1199).
 * Extracted from ComparePanel; the actual topic creation lives in the panel so
 * it can coordinate the BCF store + viewpoint capture.
 */

import { useMemo } from 'react';
import { MessageSquarePlus, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { BCFTopic } from '@ifc-lite/bcf';
import type { ChangeDetail } from '@/lib/compare/describeChange';
import { BCFCreateTopicForm } from '../bcf/BCFCreateTopicForm';
import { bcfTextFromChange, type CompareRow } from './changeRow';

interface BcfFromChangeProps {
  row: CompareRow;
  detail: ChangeDetail | null;
  author: string;
  open: boolean;
  createdTitle: string | null;
  onStart: () => void;
  onCancel: () => void;
  onSubmit: (topic: Partial<BCFTopic>, options?: { includeSnapshot: boolean }) => void;
  onOpenBcfPanel: () => void;
  /** Live viewpoint snapshot preview (data URL) for the create form. */
  snapshot?: string | null;
  /** (Re)capture the snapshot from the current view. */
  onCaptureSnapshot?: () => void;
  /** True while a snapshot capture is in flight. */
  capturingSnapshot?: boolean;
}

export function BcfFromChange({
  row,
  detail,
  author,
  open,
  createdTitle,
  onStart,
  onCancel,
  onSubmit,
  onOpenBcfPanel,
  snapshot,
  onCaptureSnapshot,
  capturingSnapshot,
}: BcfFromChangeProps) {
  const prefill = useMemo(() => bcfTextFromChange(row, detail), [row, detail]);

  if (createdTitle) {
    return (
      <div className="border-t border-border shrink-0 px-3 py-2.5 flex items-center gap-2 text-xs">
        <CheckCircle2 className="h-4 w-4 text-[#9ece6a] shrink-0" />
        <span className="min-w-0 truncate">BCF issue created: “{createdTitle}”</span>
        <Button variant="outline" size="sm" className="ml-auto h-7 px-2 text-xs shrink-0" onClick={onOpenBcfPanel}>
          Open BCF
        </Button>
      </div>
    );
  }

  if (open) {
    // Composing a BCF issue: the diff chrome is collapsed (ComparePanel), so the
    // form owns the remaining height and scrolls internally — its actions stay
    // reachable instead of being clipped off the bottom of the panel.
    return (
      <div className="flex-1 min-h-0 overflow-auto border-t border-border">
        <BCFCreateTopicForm
          author={author}
          initialTitle={prefill.title}
          initialDescription={prefill.description}
          onSubmit={onSubmit}
          onCancel={onCancel}
          snapshot={snapshot}
          onCaptureSnapshot={onCaptureSnapshot}
          capturingSnapshot={capturingSnapshot}
        />
      </div>
    );
  }

  return (
    <div className="border-t border-border shrink-0 px-3 py-2.5">
      <Button variant="outline" size="sm" className="w-full gap-1.5 text-xs" onClick={onStart}>
        <MessageSquarePlus className="h-3.5 w-3.5" />
        Create BCF issue
      </Button>
    </div>
  );
}
