/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared chrome and guarded lifecycle for export dialogs (#5848).
 *
 * `GLBExportDialog.tsx`, `KmzExportDialog.tsx` and `UsdExportDialog.tsx` each
 * hand-rolled the same `open`/`isExporting`/`exportResult` state, the same
 * `<Dialog>`/`<DialogHeader>`/`<DialogFooter>` shell, the same result
 * `<Alert>`, and the same guarded Cancel/Export footer wired through
 * `useExportDialogOpenGuard` (#5605). This component is that chrome, once:
 * it owns `open`, `isExporting` and the last run's result, wires the #5605
 * open guard itself (so a reopened dialog never shows a stale result), and
 * renders a filename preview when the caller can say what the download will
 * be named. Each dialog keeps its own options (model picker, colour source,
 * altitude mode, ...) as `children`, and its own export logic behind
 * `onExport`, which returns the outcome the shell renders rather than
 * setting result state itself.
 *
 * `children` may be a plain node or a `(state) => node` render prop when a
 * dialog's options need to know whether the dialog is currently open (e.g.
 * `KmzExportDialog`'s altitude hint, which only evaluates while open).
 *
 * The ordinary layout owns its open state. A controlled `open` prop supports
 * dialogs reached from another surface, while `previewPane` selects the
 * non-modal split layout used by anonymized export. Both layouts keep one
 * close guard, progress state, result alert, filename preview, and footer.
 *
 * Two narrow, optional escape hatches for dialogs whose own logic needs to
 * observe or steer the shell's internal state, without turning it into a
 * second controlled variant:
 *  - `onOpenStateChange` fires whenever the shell's open state actually
 *    changes (open, or an unguarded close), for a dialog that gates its own
 *    expensive `useMemo`s on "is this dialog open" the way the pre-#5848
 *    per-dialog `open` state did (`PdfViewExportDialog`'s view/camera read).
 *  - `closeOnSuccess` closes the dialog on a successful export instead of
 *    showing the result Alert (`PdfViewExportDialog` closes on success and
 *    only toasts; failure still renders the Alert, which it did not do
 *    before #5848 — a strict improvement, not a behaviour change any test
 *    depended on).
 */

import type { ReactNode } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useExportDialogOpenGuard } from '@/hooks/useExportDialogOpenGuard';
import { useTranslation } from '@/i18n';
import { beginActivity, discardActivity, finishActivity, updateActivity } from '@/lib/activity/activity-journal';

/** What one export run produced, rendered as the result `<Alert>`. */
export type ExportDialogShellResult = { message: string } & (
  | { success: boolean; cancelled?: false }
  | { success: false; cancelled: true }
);

/** Register only an export's existing native cancellation authority. */
export interface ExportDialogShellActivity {
  registerCancellation: (controller: AbortController) => void;
}

/** State a render-prop `children` can read. */
export interface ExportDialogShellRenderState {
  isOpen: boolean;
  isExporting: boolean;
}

export interface ExportDialogShellProps {
  /** Trigger element. Omit only for a controlled dialog (`open`) whose host
   *  renders its own opener, such as the modified-IFC review. */
  trigger?: ReactNode;
  /** Header icon, shown beside the title. */
  icon: ReactNode;
  title: string;
  description: ReactNode;
  /** Overrides `DialogContent`'s default `sm:max-w-lg overflow-hidden`. */
  contentClassName?: string;
  cancelLabel: string;
  exportLabel: string;
  exportingLabel: string;
  /** Icon shown beside `exportLabel` when idle (omitted while exporting, which shows the spinner instead). */
  exportIcon?: ReactNode;
  /** Result Alert titles. Only needed when `onExport` can return a result. */
  successTitle?: string;
  errorTitle?: string;
  /**
   * The filename the pending export would produce for the current
   * selection, e.g. `modelExportFilename(selectedModel.name, 'glb')`.
   * Omit while nothing is selected yet.
   */
  filenamePreview?: string;
  /** Disables the Export button beyond the busy gate (e.g. no model selected). */
  exportDisabled?: boolean;
  /**
   * Runs the export and returns the outcome to render. Do NOT call
   * `setState` on a result here — return it, so the shell is the only writer
   * of the result it displays (and therefore the only place it gets cleared).
   * Return `null` when the host reports the outcome itself, e.g. the
   * modified-IFC review, which closes and hands off to a background export.
   */
  onExport: (activity: ExportDialogShellActivity) => Promise<ExportDialogShellResult | null>;
  children: ReactNode | ((state: ExportDialogShellRenderState) => ReactNode);
  /** Controlled visibility for host dialogs opened by another surface. */
  open?: boolean;
  /** Non-modal preview layout keeps the live viewport interactive. */
  previewPane?: ReactNode;
  /** Options-area styling for layouts whose controls fill the dialog height. */
  optionsClassName?: string;
  /** Content before Cancel and Export, such as an editable filename. */
  footerLeading?: ReactNode | ((state: ExportDialogShellRenderState) => ReactNode);
  /** Details below the result alert, such as export warnings. */
  resultDetails?: ReactNode;
  /** Notified whenever the shell's open state actually changes (see file header). */
  onOpenStateChange?: (open: boolean) => void;
  /** Close on a successful export instead of showing the result Alert (see file header). */
  closeOnSuccess?: boolean;
}

export function ExportDialogShell({
  trigger,
  icon,
  title,
  description,
  contentClassName,
  cancelLabel,
  exportLabel,
  exportingLabel,
  exportIcon,
  successTitle,
  errorTitle,
  filenamePreview,
  exportDisabled = false,
  onExport,
  children,
  open: controlledOpen,
  previewPane,
  optionsClassName,
  footerLeading,
  resultDetails,
  onOpenStateChange,
  closeOnSuccess = false,
}: ExportDialogShellProps) {
  const { t } = useTranslation();
  const [localOpen, setOpenState] = useState(false);
  const open = controlledOpen ?? localOpen;
  const [isExporting, setIsExporting] = useState(false);
  const [result, setResult] = useState<ExportDialogShellResult | null>(null);
  const wasOpenRef = useRef(open);

  // A host may open the controlled dialog directly through its store flag,
  // bypassing Radix's onOpenChange and the guard's onOpen callback.
  useLayoutEffect(() => {
    if (open && !wasOpenRef.current) setResult(null);
    wasOpenRef.current = open;
  }, [open]);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenStateChange?.(next);
    },
    [onOpenStateChange],
  );

  const handleOpenChange = useExportDialogOpenGuard({
    busy: isExporting,
    setOpen,
    // #5605: clear the previous run's result on open, never on close, so a
    // reopened dialog never shows a stale success/error.
    onOpen: () => setResult(null),
  });

  const handleExport = useCallback(async () => {
    setResult(null);
    setIsExporting(true);
    // The activity tray records every export this shell runs (#6925).
    const job = beginActivity({ kind: 'export', title: 'activityTray.job.export', subject: title });
    let recorded = false;
    let cancellation: AbortController | undefined;
    try {
      const outcome = await onExport({ registerCancellation: controller => {
        cancellation = controller;
        updateActivity(job, { cancel: () => controller.abort() });
      } });
      recorded = true;
      // `null`: the host reports the outcome itself (a hand-off), so the tray does not guess one.
      if (outcome === null) { discardActivity(job); return; }
      finishActivity(job, outcome.cancelled || cancellation?.signal.aborted ? 'cancelled' : outcome.success ? 'completed' : 'failed', outcome.success ? {} : { detail: outcome.message });
      if (closeOnSuccess && outcome.success) {
        setResult(null);
        setOpen(false);
      } else {
        setResult(outcome);
      }
    } catch (error) {
      if (!recorded) finishActivity(job, cancellation?.signal.aborted ? 'cancelled' : 'failed', { detail: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      setIsExporting(false);
    }
  }, [onExport, closeOnSuccess, setOpen, title]);

  const content = typeof children === 'function' ? children({ isOpen: open, isExporting }) : children;
  const leading = typeof footerLeading === 'function'
    ? footerLeading({ isOpen: open, isExporting }) : footerLeading;
  const splitPreview = previewPane !== undefined;

  const panel = (
    <>
      <DialogHeader className={splitPreview ? 'px-5 pt-4 pb-2' : undefined}>
        <DialogTitle className="flex items-center gap-2">
          {icon}
          {title}
        </DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      <div className={optionsClassName ?? 'grid gap-4 py-4 max-h-[70vh] overflow-y-auto'}>
        {content}

        {filenamePreview && (
          <p className="text-xs text-muted-foreground">
            {t('geometryExport.shell.filenamePreviewLabel')}{' '}
            <span className="font-mono">{filenamePreview}</span>
          </p>
        )}

        {result && (
          <Alert variant={result.success ? 'default' : 'destructive'}>
            {result.success ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
            {(result.success ? successTitle : errorTitle) && (
              <AlertTitle>{result.success ? successTitle : errorTitle}</AlertTitle>
            )}
            <AlertDescription>{result.message}</AlertDescription>
          </Alert>
        )}
        {resultDetails}
      </div>

      <DialogFooter className={splitPreview ? 'px-5 pb-4 pt-3 border-t sm:items-center gap-2' : undefined}>
        {leading}
        <Button variant="outline" disabled={isExporting} onClick={() => handleOpenChange(false)}>
          {cancelLabel}
        </Button>
        <Button onClick={handleExport} disabled={isExporting || exportDisabled}>
          {isExporting ? (
            <>
              <Spinner size="md" className="mr-2" />
              {exportingLabel}
            </>
          ) : (
            <>
              {exportIcon}
              {exportLabel}
            </>
          )}
        </Button>
      </DialogFooter>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} modal={!splitPreview}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent
        data-export-dialog-shell
        hideCloseButton={splitPreview}
        onInteractOutside={splitPreview ? (event) => event.preventDefault() : undefined}
        className={contentClassName ?? 'sm:max-w-lg overflow-hidden'}
      >
        {splitPreview ? (
          <>
            <div className="pointer-events-auto flex flex-col min-h-0 rounded-lg border bg-background shadow-lg">{panel}</div>
            <div className="relative pointer-events-none min-h-0">{previewPane}</div>
          </>
        ) : panel}
      </DialogContent>
    </Dialog>
  );
}
