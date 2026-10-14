/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The planes on the Section bar (#7545): one chip per plane, in creation order,
 * the active one filled. A chip's dot is filled while its plane is cutting and
 * hollow while it is only a preview. Chips are tabs (arrow keys move, Enter or
 * click activates, F2 renames, Delete removes); everything else about a plane
 * lives in its `⋯` menu.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SectionPlane, SectionPlaneAxis } from '@/store/types';
import { resetSectionToAxis } from '@/store/section-active';
import { leaveAlignmentMode } from '@/lib/section/alignment-controller';
import { useSectionPlaneSet } from './useSectionPlaneSet';
import { useLiveTestId } from './SectionBarMeasure';

const DIRECTIONS: ReadonlyArray<{ axis: SectionPlaneAxis; labelKey: 'sectionPlanes.addDown' | 'sectionPlanes.addFront' | 'sectionPlanes.addSide' }> = [
  { axis: 'down', labelKey: 'sectionPlanes.addDown' },
  { axis: 'front', labelKey: 'sectionPlanes.addFront' },
  { axis: 'side', labelKey: 'sectionPlanes.addSide' },
];

const CHIP = 'inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs transition-colors';

/** Tell the user a removal can be taken back; the record lives in the store until the set changes again. */
function offerUndo(t: ReturnType<typeof useTranslation>['t']): void {
  const record = useViewerStore.getState().sectionUndo;
  if (!record) return;
  toast.info(
    t(record.label === 'cleared' ? 'sectionPlanes.undo.cleared' : 'sectionPlanes.undo.removed', { name: record.name }),
    { label: t('sectionPlanes.undo.action'), onClick: () => useViewerStore.getState().undoSectionChange() },
  );
}

function RenameInput({ plane, onDone }: { plane: SectionPlane; onDone: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  // One outcome per edit: Enter commits and the input unmounts, and a browser that then reports a blur
  // must not apply the name a second time (nor commit after Escape).
  const finished = useRef(false);
  useEffect(() => { ref.current?.select(); }, []);
  const commit = () => {
    if (finished.current) return;
    finished.current = true;
    useViewerStore.getState().renameSectionPlane(plane.id, ref.current?.value ?? plane.name);
    onDone();
  };
  const cancel = () => {
    if (finished.current) return;
    finished.current = true;
    onDone();
  };
  return (
    <input
      ref={ref}
      defaultValue={plane.name}
      maxLength={24}
      aria-label={t('sectionPlanes.rename.aria')}
      className="h-5 w-20 rounded-sm border border-border bg-background px-1 text-xs text-foreground"
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') cancel();
      }}
    />
  );
}

/** The `⋯` menu for one plane. */
export function SectionPlaneMenu({ plane, onRename }: { plane: SectionPlane; onRename: () => void }) {
  const { t } = useTranslation();
  const triggerTestId = useLiveTestId('section-plane-menu');
  const contentTestId = useLiveTestId('section-plane-menu-content');
  const store = useViewerStore;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('sectionPlanes.menu.aria', { name: plane.name })}
          title={t('sectionPlanes.menu.aria', { name: plane.name })}
          className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent"
          data-testid={triggerTestId}
        >
          <MoreHorizontal aria-hidden className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid={contentTestId}>
        <DropdownMenuItem onSelect={onRename}>{t('sectionPlanes.menu.rename')}</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked={plane.enabled} onCheckedChange={(on) => store.getState().setSectionPlaneCutting(plane.id, on)}>
          {t('sectionPlanes.menu.cut')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={plane.showGizmo} onCheckedChange={(on) => store.getState().setSectionPlaneShowGizmo(plane.id, on)}>
          {t('sectionPlanes.menu.show')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem onSelect={() => store.getState().duplicateSectionPlane(plane.id)}>{t('sectionPlanes.menu.duplicate')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* What this plane IS: a direction, or a picked face. Changing it keeps the plane's name and place in the set. */}
        <DropdownMenuLabel className="text-2xs">{t('sectionPlanes.menu.direction')}</DropdownMenuLabel>
        {DIRECTIONS.map(({ axis, labelKey }) => (
          <DropdownMenuCheckboxItem
            key={axis}
            checked={!plane.custom && !plane.box && plane.axis === axis}
            onCheckedChange={() => { leaveAlignmentMode(); resetSectionToAxis(store.getState, axis); }}
          >
            {t(labelKey)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuItem onSelect={() => { leaveAlignmentMode(); store.getState().setSectionPickMode(true); }}>{t('sectionPlanes.addFace')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => { store.getState().removeSectionPlane(plane.id); offerUndo(t); }}>{t('sectionPlanes.menu.remove')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { store.getState().clearSectionPlanes(); offerUndo(t); }}>{t('sectionPlanes.menu.clearAll')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SectionPlaneChips() {
  const { t } = useTranslation();
  const chipsTestId = useLiveTestId('section-plane-chips');
  const { active, planes } = useSectionPlaneSet();
  const [renaming, setRenaming] = useState<string | null>(null);
  const activate = useViewerStore((s) => s.activateSectionPlane);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, index: number) => {
    const plane = planes[index]!;
    if (e.key === 'F2') { e.preventDefault(); setRenaming(plane.id); return; }
    if (e.key === 'Delete') {
      e.preventDefault();
      useViewerStore.getState().removeSectionPlane(plane.id);
      offerUndo(t);
      return;
    }
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = planes[(index + step + planes.length) % planes.length]!;
    activate(next.id);
    // Each chip sits in its own wrapper, so the sibling is found from the tablist, not from the chip's parent.
    (e.currentTarget.closest('[role="tablist"]')?.querySelector<HTMLElement>(`[data-plane-id="${next.id}"]`))?.focus();
  };

  return (
    <span role="tablist" aria-label={t('sectionPlanes.chipsAria')} className="flex items-center gap-0.5" data-testid={chipsTestId}>
      {planes.map((plane, index) => {
        const selected = plane.id === active.id;
        return (
          <span key={plane.id} className="inline-flex items-center">
            {renaming === plane.id ? (
              <RenameInput plane={plane} onDone={() => setRenaming(null)} />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                data-plane-id={plane.id}
                title={t(plane.enabled ? 'sectionPlanes.chipCutting' : 'sectionPlanes.chipPreview', { name: plane.name })}
                onClick={() => activate(plane.id)}
                onDoubleClick={() => setRenaming(plane.id)}
                onKeyDown={(e) => onKeyDown(e, index)}
                className={cn(CHIP, selected ? 'bg-overlay-accent-soft text-overlay-accent' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground')}
              >
                <span aria-hidden className={cn('inline-block h-2 w-2 rounded-full border', plane.enabled ? 'border-current bg-current' : 'border-current')} />
                {plane.name}
              </button>
            )}
          </span>
        );
      })}
      {/* After every chip, not beside the selected one: choosing a plane must not move the others. */}
      <SectionPlaneMenu plane={active} onRename={() => setRenaming(active.id)} />
    </span>
  );
}
