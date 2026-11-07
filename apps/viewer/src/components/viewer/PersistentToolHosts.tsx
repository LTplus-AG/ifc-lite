/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { BulkPropertyEditor } from './BulkPropertyEditor';
import { DataConnector } from './DataConnector';
import { ClassVisibilityControls } from './toolbar/ClassVisibilityMenu';
import { useSectionPaletteHost } from './section-palette-host';
import type { SurfaceCommandContext } from './surface-command-types';

type ToolContext = Pick<SurfaceCommandContext, 'openBulkProperties' | 'openImportData' | 'openClassFilter' | 'toolHostIsCurrent' | 'addSectionPlane' | 'sectionAddUnavailable'>;
const ToolHosts = createContext<ToolContext>({});
export const usePersistentToolHosts = () => useContext(ToolHosts);

/** One owner survives palette close, ribbon collapse, and tab changes (#8947). */
export function PersistentToolHosts({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const sectionHost = useSectionPaletteHost();
  const [bulk, setBulk] = useState(false);
  const [data, setData] = useState(false);
  const [classes, setClasses] = useState(false);
  const alive = useRef(true);
  const classLauncher = useRef<HTMLElement | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const context = useMemo<ToolContext>(() => {
    const canOpenAuthor = () => {
      const s = useViewerStore.getState();
      return alive.current && !s.loading && (s.collabRole === null || s.collabRole === 'editor' || s.collabRole === 'admin')
        && (s.ifcDataStore !== null || [...s.models.values()].some(m => m.ifcDataStore != null));
    };
    return {
      toolHostIsCurrent: () => alive.current,
      openBulkProperties: () => { if (canOpenAuthor()) setBulk(true); },
      openImportData: () => { if (canOpenAuthor()) setData(true); },
      openClassFilter: (launcher) => { if (alive.current) {
        classLauncher.current = launcher ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        setClasses(true);
      } },
    };
  }, []);
  return <ToolHosts.Provider value={{ ...context, ...sectionHost }}>
    {children}
    <BulkPropertyEditor open={bulk} onOpenChange={setBulk} />
    <DataConnector open={data} onOpenChange={setData} />
    <Dialog open={classes} onOpenChange={setClasses}>
      <DialogContent className="max-w-sm max-h-[85dvh] overflow-y-auto" aria-describedby={undefined}
        onCloseAutoFocus={event => { event.preventDefault(); if (classLauncher.current?.isConnected) classLauncher.current.focus(); }}>
        <DialogTitle>{t('classVisibility.heading')}</DialogTitle>
        <ClassVisibilityControls onNavigate={() => setClasses(false)} />
      </DialogContent>
    </Dialog>
  </ToolHosts.Provider>;
}
