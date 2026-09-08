/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Save 2D drawing markup into the IFC model" (#4153) — the button.
 *
 * Two render shapes sharing one handler (`useSaveDrawingMarkupHandler`):
 * `SaveMarkupToModelButton` for the wide toolbar, `SaveMarkupToModelMenuItem`
 * for the narrow layout's overflow `DropdownMenu` — `Section2DPanel.tsx`
 * renders whichever its own width breakpoint picked, same as every other
 * action in that toolbar.
 *
 * ## Wording is deliberately NOT "Saved" / "Save to file"
 * `saveDrawingMarkupToModel` writes into the model's `StoreEditor` overlay
 * only — the same overlay `ExportChangesButton` already reads from. Nothing
 * touches disk here. Every toast this component shows says "into the
 * model" / "use Export Changes to save it to a file" rather than "Saved" on
 * its own, so a user cannot read a successful click as "my markup is now on
 * disk" when it is only staged for the next export.
 */

import { useCallback, useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { saveDrawingMarkupToModel, type SaveMarkupRefusal } from '@/lib/drawing2d-markup/drawing-markup-save';

function targetViewFor(axis: string | undefined): 'PLAN_VIEW' | 'SECTION_VIEW' {
  return axis === 'down' ? 'PLAN_VIEW' : 'SECTION_VIEW';
}

function refusalText(refusal: SaveMarkupRefusal | 'no-active-model'): string {
  switch (refusal) {
    case 'no-active-model':
    case 'no-model':
      return 'No model is loaded to save markup into.';
    case 'no-anchor':
      return 'This model has no storey to anchor markup against.';
    case 'no-root-context':
      return 'This model has no 3D representation context to attach markup to.';
    case 'nothing-to-save':
      return 'No markup to save — draw a measurement, area, note or cloud first.';
    case 'invalid-markup':
      return 'One of your markup items has an invalid (missing or infinite) measurement and cannot be saved — check the console for which one, delete it, and try again.';
  }
}

/** Shared handler behind both the toolbar icon button and the overflow-menu item. */
function useSaveDrawingMarkupHandler() {
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const measure2DResults = useViewerStore((s) => s.measure2DResults);
  const polygonArea2DResults = useViewerStore((s) => s.polygonArea2DResults);
  const textAnnotations2D = useViewerStore((s) => s.textAnnotations2D);
  const cloudAnnotations2D = useViewerStore((s) => s.cloudAnnotations2D);
  const sectionAxis = useViewerStore((s) => s.sectionPlane.axis);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = useCallback(() => {
    if (!activeModelId) {
      toast.error(refusalText('no-active-model'));
      return;
    }
    setIsSaving(true);
    try {
      const outcome = saveDrawingMarkupToModel(
        activeModelId,
        { measure2DResults, polygonArea2DResults, textAnnotations2D, cloudAnnotations2D },
        targetViewFor(sectionAxis),
      );
      if (outcome.refusal) {
        toast.error(refusalText(outcome.refusal));
        return;
      }
      const saved = outcome.measuresSaved + outcome.polygonsSaved + outcome.textsSaved + outcome.cloudsSaved;
      toast.success(
        saved > 0
          ? `Added ${saved} markup annotation${saved === 1 ? '' : 's'} to the model — use Export Changes to save it to a file.`
          : 'Cleared previously saved markup from the model — use Export Changes to save it to a file.',
      );
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[SaveMarkupToModelButton] save failed:', error);
      toast.error(`Could not save markup into the model: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsSaving(false);
    }
  }, [activeModelId, measure2DResults, polygonArea2DResults, textAnnotations2D, cloudAnnotations2D, sectionAxis]);

  return { handleSave, isSaving, disabled: !activeModelId || isSaving };
}

const TITLE = 'Save drawing markup into the model (overlay only — Export Changes writes it to a file)';

/** Toolbar icon-button variant, for the wide layout. */
export function SaveMarkupToModelButton() {
  const { handleSave, disabled } = useSaveDrawingMarkupHandler();
  return (
    <Button variant="ghost" size="icon-sm" onClick={handleSave} disabled={disabled} title={TITLE}>
      <Save className="h-4 w-4" />
    </Button>
  );
}

/** Overflow-menu item variant, for the narrow layout's `DropdownMenu`. */
export function SaveMarkupToModelMenuItem() {
  const { handleSave, disabled } = useSaveDrawingMarkupHandler();
  return (
    <DropdownMenuItem onClick={handleSave} disabled={disabled}>
      <Save className="h-4 w-4 mr-2" />
      Save Markup to Model
    </DropdownMenuItem>
  );
}
