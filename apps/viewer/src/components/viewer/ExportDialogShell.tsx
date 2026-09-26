/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared chrome for the geometry export dialogs (#5848).
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
 * State is self-contained (uncontrolled), matching how all three dialogs are
 * called today — each is mounted with just a `trigger`/`surface` prop and
 * manages its own visibility — rather than the fully-controlled pattern
 * `IDSExportDialog` uses for its externally-driven progress. A future dialog
 * that needs externally-driven progress (multi-step, cancellable) is a
 * reason to add a second, controlled variant, not to bend this one.
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
import { useCallback, useState } from 'react';
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

/** What one export run produced, rendered as the result `<Alert>`. */
export interface ExportDialogShellResult {
  success: boolean;
  message: string;
}

/** State a render-prop `children` can read. */
export interface ExportDialogShellRenderState {
  isOpen: boolean;
  isExporting: boolean;
}

export interface ExportDialogShellProps {
  /** Trigger element. The dialog always renders a trigger — callers supply
   *  their own fallback (icon + label) the same way they did before migrating. */
  trigger: ReactNode;
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
  successTitle: string;
  errorTitle: string;
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
   */
  onExport: () => Promise<ExportDialogShellResult>;
  children: ReactNode | ((state: ExportDialogShellRenderState) => ReactNode);
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
  onOpenStateChange,
  closeOnSuccess = false,
}: ExportDialogShellProps) {
  const { t } = useTranslation();
  const [open, setOpenState] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [result, setResult] = useState<ExportDialogShellResult | null>(null);

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
    try {
      const outcome = await onExport();
      if (closeOnSuccess && outcome.success) {
        setResult(null);
        setOpen(false);
      } else {
        setResult(outcome);
      }
    } finally {
      setIsExporting(false);
    }
  }, [onExport, closeOnSuccess, setOpen]);

  const content = typeof children === 'function' ? children({ isOpen: open, isExporting }) : children;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent data-export-dialog-shell className={contentClassName ?? 'sm:max-w-lg overflow-hidden'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {icon}
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4 max-h-[70vh] overflow-y-auto">
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
              <AlertTitle>{result.success ? successTitle : errorTitle}</AlertTitle>
              <AlertDescription>{result.message}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
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
      </DialogContent>
    </Dialog>
  );
}
