/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { LayoutDashboard, Library, Plus, RotateCcw, Sparkles, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface MorphToolbarProps {
  enabled: boolean;
  onToggle: () => void;
  onAddPanel: () => void;
  onLibrary: () => void;
  onModes: () => void;
  onStudio: () => void;
  onReset: () => void;
}

export function MorphToolbar({
  enabled,
  onToggle,
  onAddPanel,
  onLibrary,
  onModes,
  onStudio,
  onReset,
}: MorphToolbarProps) {
  return (
    <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded border bg-background/90 p-1 shadow-sm backdrop-blur">
      <Button type="button" size="sm" variant={enabled ? 'default' : 'secondary'} onClick={onToggle}>
        <LayoutDashboard className="mr-1 h-3.5 w-3.5" />
        {enabled ? 'Morphing' : 'Morph UI'}
      </Button>
      {enabled && (
        <>
          <Button type="button" size="icon-sm" variant="ghost" onClick={onAddPanel} aria-label="Add personal panel">
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" onClick={onLibrary} aria-label="Open panel library">
            <Library className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" onClick={onModes} aria-label="Open workspace modes and automations">
            <Wand2 className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" onClick={onStudio} aria-label="Open Customization Studio">
            <Sparkles className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" onClick={onReset} aria-label="Reset layout">
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}
