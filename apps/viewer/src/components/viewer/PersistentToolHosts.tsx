/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createContext, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary';
import { ClassVisibilityControls } from './toolbar/ClassVisibilityMenu';
import { useSectionPaletteHost } from './section-palette-host';
import type { SurfaceCommandContext } from './surface-command-types';

const BulkPropertyEditor = lazy(() => import('./BulkPropertyEditor').then(module => ({ default: module.BulkPropertyEditor })));
const DataConnector = lazy(() => import('./DataConnector').then(module => ({ default: module.DataConnector })));

type ToolContext = Pick<SurfaceCommandContext, 'openBulkProperties' | 'openImportData' | 'openClassFilter' | 'toolHostIsCurrent' | 'addSectionPlane' | 'sectionAddUnavailable'>;
const ToolHosts = createContext<ToolContext>({});
export const usePersistentToolHosts = () => useContext(ToolHosts);

/** One owner survives palette close, ribbon collapse, and tab changes (#8947). */
export function PersistentToolHosts({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const sectionHost = useSectionPaletteHost();
  const [bulk, setBulk] = useState(false);
  const [data, setData] = useState(false);
  const [bulkRequested, setBulkRequested] = useState(false);
  const [dataRequested, setDataRequested] = useState(false);
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
      openBulkProperties: () => { if (canOpenAuthor()) { setBulkRequested(true); setBulk(true); } },
      openImportData: () => { if (canOpenAuthor()) { setDataRequested(true); setData(true); } },
      openClassFilter: (launcher) => { if (alive.current) {
        classLauncher.current = launcher ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        setClasses(true);
      } },
    };
  }, []);
  return <ToolHosts.Provider value={{ ...context, ...sectionHost }}>
    {children}
    {/* Latch the first eligible request; closing must retain each tool's drafts (#8947). */}
    {bulkRequested && <ChunkErrorBoundary label="Bulk Property Editor" renderFallback={fallback => (
      <AuthorLoadDialog open={bulk} onOpenChange={setBulk} title={t('bulkPropertyEditor.title')}>{fallback}</AuthorLoadDialog>
    )}>
      <Suspense fallback={<AuthorLoadDialog open={bulk} onOpenChange={setBulk} title={t('bulkPropertyEditor.title')}>
        <output>{t('shellChrome.statusBar.loadingFallback')}</output>
      </AuthorLoadDialog>}>
        <BulkPropertyEditor open={bulk} onOpenChange={setBulk} />
      </Suspense>
    </ChunkErrorBoundary>}
    {dataRequested && <ChunkErrorBoundary label="Data Connector" renderFallback={fallback => (
      <AuthorLoadDialog open={data} onOpenChange={setData} title={t('dataConnector.dialogTitle')}>{fallback}</AuthorLoadDialog>
    )}>
      <Suspense fallback={<AuthorLoadDialog open={data} onOpenChange={setData} title={t('dataConnector.dialogTitle')}>
        <output>{t('shellChrome.statusBar.loadingFallback')}</output>
      </AuthorLoadDialog>}>
        <DataConnector open={data} onOpenChange={setData} />
      </Suspense>
    </ChunkErrorBoundary>}
    <Dialog open={classes} onOpenChange={setClasses}>
      <DialogContent viewportBounds="height" className="max-w-sm overflow-y-auto" aria-describedby={undefined}
        onCloseAutoFocus={event => { event.preventDefault(); if (classLauncher.current?.isConnected) classLauncher.current.focus(); }}>
        <DialogTitle>{t('classVisibility.heading')}</DialogTitle>
        <ClassVisibilityControls onNavigate={() => setClasses(false)} />
      </DialogContent>
    </Dialog>
  </ToolHosts.Provider>;
}

/** Only the loading/error overlay is transient; the real tool retains its owner. */
function AuthorLoadDialog({ open, onOpenChange, title, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  const openRef = useRef(open);
  openRef.current = open;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent aria-describedby={undefined} onCloseAutoFocus={event => {
      // Resolving Suspense transfers focus to the real dialog, not the old launcher.
      if (openRef.current) event.preventDefault();
    }}>
      <DialogTitle>{title}</DialogTitle>
      {children}
    </DialogContent>
  </Dialog>;
}
