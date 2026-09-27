/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bottom strip's header (#5498): a tab row for the bottom panels opened
 * this session (the active one is still the existing mutually-exclusive
 * flag, `lib/panels/bottom-panels`), the detach grip, maximize/restore, and
 * a single Close — replacing the per-panel title/close rows Script,
 * Schedule, Lists, Charts, Document, Flow and Drawing used to draw for
 * themselves. Reuses the Properties panel's tab look (`properties-tab-
 * trigger`, `index.css`) via the same class names and `data-state`
 * attribute, so a strip with several panels open reads like the rest of the
 * shell chrome rather than a bespoke widget.
 */

import { Grip, Maximize2, Minimize2, PanelBottom, PanelRight, X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { getPanelDef } from '@/lib/panels/registry';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';
import type { BottomStripOrientation } from '@/lib/panels/bottom-strip-persistence';
import { usePanelDetachDrag } from '@/hooks/usePanelDetachDrag';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const ICON_BUTTON_CLASS =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground';

/** Small drag affordance — pointerdown lifts the active panel into a
 *  floating window / another screen's OS window (#1208). Same gesture the
 *  full-width grip bar used before #5498, now sized to sit in the tab row. */
function DetachGrip({ id }: { id: BottomPanelId }) {
  const { t } = useTranslation();
  const onPointerDown = usePanelDetachDrag(id);
  return (
    <div
      onPointerDown={onPointerDown}
      title={t('bottomStrip.gripTitle')}
      className={`${ICON_BUTTON_CLASS} cursor-grab touch-none select-none active:cursor-grabbing`}
    >
      <Grip className="h-3.5 w-3.5" />
    </div>
  );
}

export interface BottomStripHeaderProps {
  /** Bottom panels opened this session, in the order they were opened. */
  tabs: readonly BottomPanelId[];
  /** The panel the mutually-exclusive dock flag currently shows. */
  activePanel: BottomPanelId;
  onSelectTab: (id: BottomPanelId) => void;
  onCloseTab: (id: BottomPanelId) => void;
  isMaximized: boolean;
  onToggleMaximize: () => void;
  /** Current dock side — only meaningful together with `onToggleOrientation`
   *  below; the control that reads/sets this is Drawing-only (#5515). */
  orientation?: BottomStripOrientation;
  /** Present only when the active panel can go side-by-side with the 3D view
   *  (Drawing, #5515) — its presence alone gates the toggle button, so no
   *  extra "which panel" prop is needed here. */
  onToggleOrientation?: () => void;
}

export function BottomStripHeader({
  tabs,
  activePanel,
  onSelectTab,
  onCloseTab,
  isMaximized,
  onToggleMaximize,
  orientation = 'bottom',
  onToggleOrientation,
}: BottomStripHeaderProps) {
  const { t } = useTranslation();
  return (
    <Tabs value={activePanel} onValueChange={(value) => onSelectTab(value as BottomPanelId)} className="flex shrink-0 items-stretch border-b bg-muted/10">
      <TabsList
        aria-label={t('bottomStrip.tabListAriaLabel')}
        className="properties-tabs-list min-w-0 h-auto flex-1 justify-start overflow-x-auto rounded-none bg-transparent p-0"
      >
        {tabs.map((id) => {
          const def = getPanelDef(id);
          const Icon = def?.Icon;
          const label = def?.short ?? id;
          return (
            <div
              key={id}
              className="group flex shrink-0 items-center"
            >
              <TabsTrigger
                value={id}
                id={`bottom-strip-tab-${id}`}
                aria-controls={`bottom-strip-panel-${id}`}
                className="properties-tab-trigger flex shrink-0 cursor-pointer items-center gap-1.5 rounded-none bg-transparent shadow-none data-[state=active]:shadow-none"
              >
                {Icon && <Icon className="panel-compact-icon h-3 w-3 shrink-0" />}
                <span className="panel-compact-text whitespace-nowrap">{label}</span>
              </TabsTrigger>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(id);
                }}
                aria-label={t('bottomStrip.closeTabAriaLabel', { name: label })}
                className="shrink-0 rounded p-0.5 opacity-60 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </TabsList>
      <div className="flex shrink-0 items-center gap-0.5 px-1">
        <DetachGrip id={activePanel} />
        {activePanel === 'drawing' && onToggleOrientation && (
          <button
            type="button"
            onClick={onToggleOrientation}
            aria-label={orientation === 'side' ? t('bottomStrip.dockBelow') : t('bottomStrip.dockBeside')}
            title={orientation === 'side' ? t('bottomStrip.dockBelow') : t('bottomStrip.dockBeside')}
            className={ICON_BUTTON_CLASS}
          >
            {orientation === 'side' ? <PanelBottom className="h-3.5 w-3.5" /> : <PanelRight className="h-3.5 w-3.5" />}
          </button>
        )}
        <button
          type="button"
          onClick={onToggleMaximize}
          aria-label={isMaximized ? t('bottomStrip.restore') : t('bottomStrip.maximize')}
          className={ICON_BUTTON_CLASS}
        >
          {isMaximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => onCloseTab(activePanel)}
          aria-label={t('bottomStrip.close')}
          className={ICON_BUTTON_CLASS}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </Tabs>
  );
}
