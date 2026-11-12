/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createContext, lazy, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary';
import { ClassVisibilityControls } from './toolbar/ClassVisibilityMenu';
import { useSectionPaletteHost } from './section-palette-host';
import type { SurfaceCommandContext } from './surface-command-types';

const BulkPropertyEditor = lazy(() => import('./BulkPropertyEditor').then(module => ({ default: module.BulkPropertyEditor })));
const DataConnector = lazy(() => import('./DataConnector').then(module => ({ default: module.DataConnector })));
// The derivation and its structural write path load only when the command is used (#9668).
const StructuralDerivationDialog = lazy(() => import('./assistant/StructuralDerivationReview').then(module => ({ default: module.StructuralDerivationDialog })));

type ToolContext = Pick<SurfaceCommandContext, 'openBulkProperties' | 'openImportData' | 'openClassFilter' | 'openStructuralDerivation' | 'toolHostIsCurrent' | 'addSectionPlane' | 'sectionAddUnavailable'>;
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
  // Each opening derives afresh: the session keys a new review.
  const [derivation, setDerivation] = useState<{ open: boolean; session: number }>({ open: false, session: 0 });
  const derivationLauncher = useRef<HTMLElement | null>(null);
  const setDerivationOpen = (open: boolean) => setDerivation(current => ({ ...current, open }));
  const restoreDerivation = (event: Event) => { event.preventDefault(); if (derivationLauncher.current?.isConnected) derivationLauncher.current.focus(); };
  const alive = useRef(true);
  const bulkLauncher = useRef<HTMLElement | null>(null);
  const dataLauncher = useRef<HTMLElement | null>(null);
  const restoreBulk = (event: Event) => { event.preventDefault(); if (bulkLauncher.current?.isConnected) bulkLauncher.current.focus(); };
  const restoreData = (event: Event) => { event.preventDefault(); if (dataLauncher.current?.isConnected) dataLauncher.current.focus(); };
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
      openBulkProperties: (launcher) => { if (canOpenAuthor()) { bulkLauncher.current = launcher ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null); setBulkRequested(true); setBulk(true); } },
      openImportData: (launcher) => { if (canOpenAuthor()) { dataLauncher.current = launcher ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null); setDataRequested(true); setData(true); } },
      openStructuralDerivation: (launcher) => { if (canOpenAuthor()) {
        derivationLauncher.current = launcher ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        setDerivation(current => ({ open: true, session: current.session + 1 }));
      } },
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
      <AuthorLoadDialog open={bulk} onOpenChange={setBulk} onCloseAutoFocus={restoreBulk} title={t('bulkPropertyEditor.title')}>{fallback}</AuthorLoadDialog>
    )}>
      <Suspense fallback={<AuthorLoadDialog open={bulk} onOpenChange={setBulk} onCloseAutoFocus={restoreBulk} title={t('bulkPropertyEditor.title')}>
        <output>{t('shellChrome.statusBar.loadingFallback')}</output>
      </AuthorLoadDialog>}>
        <BulkPropertyEditor open={bulk} onOpenChange={setBulk} onCloseAutoFocus={restoreBulk} />
      </Suspense>
    </ChunkErrorBoundary>}
    {dataRequested && <ChunkErrorBoundary label="Data Connector" renderFallback={fallback => (
      <AuthorLoadDialog open={data} onOpenChange={setData} onCloseAutoFocus={restoreData} title={t('dataConnector.dialogTitle')}>{fallback}</AuthorLoadDialog>
    )}>
      <Suspense fallback={<AuthorLoadDialog open={data} onOpenChange={setData} onCloseAutoFocus={restoreData} title={t('dataConnector.dialogTitle')}>
        <output>{t('shellChrome.statusBar.loadingFallback')}</output>
      </AuthorLoadDialog>}>
        <DataConnector open={data} onOpenChange={setData} onCloseAutoFocus={restoreData} />
      </Suspense>
    </ChunkErrorBoundary>}
    {/* Keyed per opening, so a failed render or load is retried the next time. */}
    {derivation.session > 0 && <ChunkErrorBoundary key={derivation.session} label="Structural derivation" renderFallback={fallback => (
      <AuthorLoadDialog open={derivation.open} onOpenChange={setDerivationOpen} onCloseAutoFocus={restoreDerivation} title={t('commandPalette.tool.deriveStructural.label')}>{fallback}</AuthorLoadDialog>
    )}>
      <Suspense fallback={<AuthorLoadDialog open={derivation.open} onOpenChange={setDerivationOpen} onCloseAutoFocus={restoreDerivation} title={t('commandPalette.tool.deriveStructural.label')}>
        <output>{t('shellChrome.statusBar.loadingFallback')}</output>
      </AuthorLoadDialog>}>
        <StructuralDerivationDialog open={derivation.open} onOpenChange={setDerivationOpen} onCloseAutoFocus={restoreDerivation} session={derivation.session} />
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
function AuthorLoadDialog({ open, onOpenChange, onCloseAutoFocus, title, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
  title: string;
  children: ReactNode;
}) {
  const openRef = useRef(open);
  useLayoutEffect(() => { openRef.current = open; }, [open]);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent aria-describedby={undefined} onCloseAutoFocus={event => {
      // Resolving Suspense transfers focus to the real dialog, not the old launcher.
      if (openRef.current) event.preventDefault();
      else onCloseAutoFocus(event);
    }}>
      <DialogTitle>{title}</DialogTitle>
      {children}
    </DialogContent>
  </Dialog>;
}
