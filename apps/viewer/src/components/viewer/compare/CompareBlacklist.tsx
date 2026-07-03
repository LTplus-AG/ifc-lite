/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ignored-classes control for the Compare panel (issue #1470).
 *
 * Some IFC classes are noise in a comparison: an `IfcOpeningElement` is only the
 * connective void between a wall and a window, so when the window is removed the
 * opening's deletion isn't a meaningful change on its own. Blacklisting a class
 * drops it from the diff entirely (counts, list, 3D, and the exported report);
 * the choice persists across files.
 *
 * Deliberately one compact wrapping line that reuses the panel's own vocabulary
 * (inline `select`, `bg-muted` chips) and renders nothing until there's actually
 * something to ignore - the "add" picker is fed from the classes present among
 * the current changes, so the noisy class in front of the user is one pick away.
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import type { ChangedTypeCount } from './changeRow';

interface CompareBlacklistProps {
  /** The active blacklist (display casing, e.g. `IfcOpeningElement`). */
  excludedTypes: string[];
  /** Classes among the current changes, most-changed first, minus the excluded. */
  changedTypeCounts: ChangedTypeCount[];
  onAdd: (type: string) => void;
  onRemove: (type: string) => void;
  onClear: () => void;
}

/** Drop the `Ifc` prefix for compact display; keep the full name in `title`. */
const shortName = (type: string): string => type.replace(/^Ifc/, '');

export function CompareBlacklist({
  excludedTypes,
  changedTypeCounts,
  onAdd,
  onRemove,
  onClear,
}: CompareBlacklistProps) {
  // Controlled back to the placeholder after each pick so the same class can be
  // re-picked later (once removed) and the select never shows a stale value.
  const [pick, setPick] = useState('');

  const hasChips = excludedTypes.length > 0;
  const hasOptions = changedTypeCounts.length > 0;
  // Nothing to add and nothing ignored -> don't spend a row on it.
  if (!hasChips && !hasOptions) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground shrink-0">Ignore</span>

      {hasOptions && (
        <select
          value={pick}
          onChange={(e) => {
            const type = e.target.value;
            if (type) onAdd(type);
            setPick('');
          }}
          title="Ignore an IFC class - not counted as changes"
          className="rounded border border-border bg-transparent px-1.5 py-0.5 text-xs text-foreground min-w-0 max-w-[10rem]"
        >
          <option value="">a class...</option>
          {changedTypeCounts.map(({ type, count }) => (
            <option key={type} value={type}>
              {shortName(type)} ({count.toLocaleString()})
            </option>
          ))}
        </select>
      )}

      {excludedTypes.map((type) => (
        <span
          key={type}
          title={`${type} - ignored`}
          className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground"
        >
          {shortName(type)}
          <button
            type="button"
            onClick={() => onRemove(type)}
            title={`Stop ignoring ${type}`}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}

      {hasChips && (
        <button
          type="button"
          onClick={onClear}
          title="Clear ignored classes"
          className="ml-0.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Clear
        </button>
      )}
    </div>
  );
}
