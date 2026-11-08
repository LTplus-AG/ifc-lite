/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The workplane's height (#9202): how far above the storey floor new elements
 * land. One number, the session plane's `offset`, read and set the same way
 * from the HUD chip and the plan header, so 3D and the plan cannot disagree on
 * it. It stands out while the plane is off the floor. Top of walls is one click
 * away; the Roof tool takes it by itself.
 */

import { useMemo } from 'react';
import { ArrowUpToLine, ChevronDown } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { resolveRoofHeight } from '@/lib/commands/modeling/registry';
import type { WorkplaneSpec } from '@/lib/commands/modeling/types';
import { cn } from '@/lib/utils';
import { HudChip, HudItem, HudPopover, HudPopoverContent, HudPopoverTrigger, HudValueField } from '../../viewport-ui/hud';
import { METRE_SYMBOL } from '../model-inspector/inspector-fields';
import { formatStoreyElevation } from './StoreyPicker';
import { Button } from '@/components/ui/button';

type StoreyPlane = Extract<WorkplaneSpec, { kind: 'storey' }>;

function useStoreyPlane(): StoreyPlane | null {
  const plane = useViewerStore((s) => s.session?.workplane ?? null);
  return plane?.kind === 'storey' ? plane : null;
}

const setHeight = (plane: StoreyPlane, offset: number) => useViewerStore.getState().setWorkplane({ ...plane, offset });
/** Floor hands the height back: the plane is at the floor, and the Roof tool may raise it again. */
const toFloor = (plane: StoreyPlane) => useViewerStore.getState().setWorkplane({ ...plane, offset: 0 }, { pinned: false });

function HeightPicker({ plane }: { plane: StoreyPlane }) {
  const { t } = useTranslation();
  const modelId = useViewerStore((s) => s.session?.modelId ?? null);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const top = useMemo(() => {
    void mutationVersion; // a wall drawn or resized moves it
    return modelId === null ? null : resolveRoofHeight(useViewerStore.getState(), modelId, plane.storeyId);
  }, [modelId, plane.storeyId, mutationVersion]);
  const preset = 'h-auto justify-start rounded-sm px-1.5 py-1 text-left text-xs font-normal tabular-nums';

  return (
    <div data-workplane-height-picker className="flex flex-col gap-1">
      <div className="px-0.5 text-2xs font-medium text-muted-foreground">{t('modelWorkspace.height.group')}</div>
      <HudValueField
        aria-label={t('modelWorkspace.height.field')}
        value={plane.offset}
        unit={METRE_SYMBOL}
        step={0.1}
        precision={2}
        onChange={(offset) => setHeight(plane, offset)}
      />
      <Button type="button" variant="ghost" data-workplane-height-preset="floor" className={preset} onClick={() => toFloor(plane)}>
        {t('modelWorkspace.height.floor')}
      </Button>
      {top !== null && Number.isFinite(top) && (
        <Button type="button" variant="ghost" data-workplane-height-preset="top-of-walls" className={preset} onClick={() => setHeight(plane, top)}>
          {t('modelWorkspace.height.topOfWalls', { height: formatStoreyElevation(top) })}
        </Button>
      )}
    </div>
  );
}

/** The chip on the 3D viewport's HUD, under the storey chip. */
export function WorkplaneHeightChip() {
  const { t } = useTranslation();
  const plane = useStoreyPlane();
  if (!plane) return null;
  const label = t('modelWorkspace.height.value', { height: formatStoreyElevation(plane.offset) });
  return (
    <HudItem region="top-left" order={1}>
      <HudPopover>
        <HudChip active={plane.offset !== 0} icon={<ArrowUpToLine aria-hidden className="h-3.5 w-3.5 shrink-0" />}>
          <HudPopoverTrigger asChild>
            <button
              type="button"
              data-workplane-height={plane.offset}
              title={t('modelWorkspace.height.title')}
              className="inline-flex min-w-0 items-center gap-1 rounded-sm tabular-nums hover:text-foreground"
            >
              {label}
              <ChevronDown aria-hidden className="h-3 w-3 shrink-0 opacity-70" />
            </button>
          </HudPopoverTrigger>
        </HudChip>
        <HudPopoverContent align="start"><HeightPicker plane={plane} /></HudPopoverContent>
      </HudPopover>
    </HudItem>
  );
}

/** The same control in the plan's header. */
export function PlanWorkplaneHeight() {
  const { t } = useTranslation();
  const plane = useStoreyPlane();
  if (!plane) return null;
  return (
    <HudPopover>
      <HudPopoverTrigger asChild>
        <button
          type="button"
          data-plan-height={plane.offset}
          title={t('modelWorkspace.height.title')}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-sm px-1 py-0.5 tabular-nums hover:bg-accent hover:text-accent-foreground',
            plane.offset !== 0 ? 'bg-overlay-accent-soft text-overlay-accent' : 'text-muted-foreground',
          )}
        >
          <ArrowUpToLine aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {t('modelWorkspace.height.value', { height: formatStoreyElevation(plane.offset) })}
        </button>
      </HudPopoverTrigger>
      <HudPopoverContent align="start"><HeightPicker plane={plane} /></HudPopoverContent>
    </HudPopover>
  );
}
