/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Share dialog's scope field (#4444): with several models loaded, what
 * the room carries — the active model only, or every loaded model, each in
 * its own room slot. Rendered only when there is a choice to make.
 *
 * The choice is live until the room exists (`editable`): a room's scope is
 * fixed by its seed, so the dialog creates the room only on "Create link".
 * Once the room exists the radios stay visible but disabled and the caption
 * reports how many models the room actually carries, which is what the seed
 * put there rather than the radio's current value.
 */

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import type { ShareScope } from '@/lib/collab/share-scope';

interface ShareScopeFieldProps {
  scope: ShareScope;
  onScopeChange: (scope: ShareScope) => void;
  /** True until the room exists: the radios and "Create link" are live. */
  editable: boolean;
  onConfirm: () => void;
  /** Number of models loaded in the workspace. */
  loadedCount: number;
  /**
   * How many of them a share of every model would carry: a GLB, a point cloud
   * or a model still loading has no parsed store and nothing to seed, so the
   * option must not promise more models than the room will hold.
   */
  seedableCount: number;
  /** Name of the active model (the "active only" option's subject). */
  activeModelName: string;
  /** Number of models the room carries once it exists, else `null`. */
  roomModelCount: number | null;
}

export function ShareScopeField({
  scope,
  onScopeChange,
  editable,
  onConfirm,
  loadedCount,
  seedableCount,
  activeModelName,
  roomModelCount,
}: ShareScopeFieldProps) {
  const partial = seedableCount !== loadedCount;
  const allLabel = partial
    ? `All ${seedableCount} of ${loadedCount} loaded models`
    : `All ${loadedCount} loaded models`;
  const caption =
    roomModelCount !== null
      ? `This room carries ${roomModelCount} model${roomModelCount === 1 ? '' : 's'}.`
      : scope === 'all'
        ? partial
          ? `${seedableCount} of ${loadedCount} loaded models can be shared, each as its own model; a GLB, a point cloud or a model still loading has nothing to put in a room.`
          : 'Every loaded model is shared as its own model, so recipients see the whole workspace.'
        : `Only “${activeModelName}” is shared; the other loaded models stay private.`;
  return (
    <div className="flex flex-col gap-2">
      <Label>Share</Label>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Share scope">
        <Button
          type="button"
          role="radio"
          aria-checked={scope === 'active'}
          variant={scope === 'active' ? 'default' : 'outline'}
          size="sm"
          className="truncate"
          disabled={!editable}
          onClick={() => onScopeChange('active')}
        >
          Active model only
        </Button>
        <Button
          type="button"
          role="radio"
          aria-checked={scope === 'all'}
          variant={scope === 'all' ? 'default' : 'outline'}
          size="sm"
          disabled={!editable}
          onClick={() => onScopeChange('all')}
        >
          {allLabel}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{caption}</p>
      {editable && (
        <Button type="button" size="sm" className="self-start" onClick={onConfirm}>
          Create link
        </Button>
      )}
    </div>
  );
}
