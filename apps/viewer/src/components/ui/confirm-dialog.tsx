/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { Input } from './input';
import { Label } from './label';
import { useTranslation } from '@/i18n';
import { PortalContainerProvider, usePortalContainer } from './portal-container';

interface BaseRequest {
  title?: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
}

export interface ConfirmOptions extends BaseRequest {}
export interface PromptOptions extends BaseRequest {
  defaultValue?: string;
}

type DialogRequest = (
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void; opener: HTMLElement | null }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void; opener: HTMLElement | null }
) & { id: number; container: HTMLElement | undefined };

let enqueue: ((request: DialogRequest) => void) | null = null;
let nextRequestId = 0;

function captureOpener(container?: HTMLElement): HTMLElement | null {
  const source = container?.ownerDocument ?? document;
  const active = source.activeElement as HTMLElement | null;
  // A menu item disappears on selection; restore focus to its stable trigger.
  const triggerId = active?.closest('[role="menu"]')?.getAttribute('aria-labelledby');
  return (triggerId ? source.getElementById(triggerId) : null) ?? active;
}

/** Ask for consent without blocking the browser's event loop. */
export function confirmDialog(options: ConfirmOptions, container?: HTMLElement): Promise<boolean> {
  return new Promise((resolve) => {
    if (!enqueue) { resolve(false); return; }
    enqueue({ id: nextRequestId++, kind: 'confirm', options, resolve, container, opener: captureOpener(container) });
  });
}

/** Ask for one string. Cancelling or pressing Esc resolves to null. */
export function promptDialog(options: PromptOptions, container?: HTMLElement): Promise<string | null> {
  return new Promise((resolve) => {
    if (!enqueue) { resolve(null); return; }
    enqueue({ id: nextRequestId++, kind: 'prompt', options, resolve, container, opener: captureOpener(container) });
  });
}

/** Keep a panel's dialogs in its own window, including the menu's modal layer. */
export function useDialogs() {
  const container = usePortalContainer();
  return useMemo(() => ({
    confirmDialog: (options: ConfirmOptions) => confirmDialog(options, container),
    promptDialog: (options: PromptOptions) => promptDialog(options, container),
  }), [container]);
}

/** The single mounted host serializes requests from every viewer surface. */
export function ConfirmDialogHost() {
  const { t } = useTranslation();
  const [requests, setRequests] = useState<DialogRequest[]>([]);
  const [value, setValue] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<DialogRequest[]>([]);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const current = requests[0];

  useEffect(() => {
    enqueue = (request) => {
      pendingRef.current.push(request);
      setRequests([...pendingRef.current]);
    };
    return () => {
      enqueue = null;
      for (const request of pendingRef.current) {
        if (request.kind === 'confirm') request.resolve(false);
        else request.resolve(null);
      }
      pendingRef.current = [];
    };
  }, []);

  useEffect(() => {
    setValue(current?.kind === 'prompt' ? current.options.defaultValue ?? '' : '');
    if (current?.kind === 'prompt') inputRef.current?.focus();
    else if (current) cancelRef.current?.focus();
  }, [current]);

  // Radix FocusScope observes the main document. A portalled popup needs the
  // same focus containment in its own document, including menu-close autofocus.
  useEffect(() => {
    const source = current?.container?.ownerDocument;
    if (!source || source === document) return;
    let lastFocused: HTMLElement | null = current.kind === 'prompt' ? inputRef.current : cancelRef.current;
    const containFocus = (event: FocusEvent) => {
      if (dialogRef.current?.contains(event.target as Node)) lastFocused = event.target as HTMLElement;
      else lastFocused?.focus();
    };
    source.addEventListener('focusin', containFocus);
    return () => source.removeEventListener('focusin', containFocus);
  }, [current]);

  const loopPopupFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!current?.container || current.container.ownerDocument === document || event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const first = current.kind === 'prompt' ? inputRef.current : cancelRef.current;
    const last = confirmRef.current;
    const active = current.container.ownerDocument.activeElement;
    if (event.shiftKey && active === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first?.focus(); }
  };

  useEffect(() => {
    const sourceWindows = new Set(requests.map((request) => request.container?.ownerDocument.defaultView).filter((win) => win && win !== window));
    const cleanups: Array<() => void> = [];
    for (const win of sourceWindows) {
      if (!win) continue;
      const cancelRequests = () => {
        pendingRef.current = pendingRef.current.filter((request) => {
          if (request.container?.ownerDocument.defaultView !== win) return true;
          if (request.kind === 'confirm') request.resolve(false);
          else request.resolve(null);
          return false;
        });
        setRequests([...pendingRef.current]);
      };
      win.addEventListener('pagehide', cancelRequests);
      cleanups.push(() => win.removeEventListener('pagehide', cancelRequests));
    }
    return () => { for (const cleanup of cleanups) cleanup(); };
  }, [requests]);

  const finish = (answer: boolean | string | null) => {
    if (!current) return;
    restoreFocusRef.current = current.opener;
    pendingRef.current = pendingRef.current.filter((request) => request !== current);
    setRequests([...pendingRef.current]);
    if (current.kind === 'confirm') current.resolve(answer === true);
    else current.resolve(typeof answer === 'string' ? answer : null);
  };

  const title = current?.options.title ?? t(current?.kind === 'prompt' ? 'viewerShell.dialog.promptTitle' : 'viewerShell.dialog.confirmTitle');
  const description = current?.options.description ?? '';
  return (
    <PortalContainerProvider container={current?.container ?? null}>
      <Dialog key={current?.id ?? 'closed'} open={!!current} onOpenChange={(open) => { if (!open) finish(null); }}>
        <DialogContent
          ref={dialogRef}
          role="alertdialog"
          hideCloseButton
          onKeyDown={loopPopupFocus}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (current?.kind === 'prompt') inputRef.current?.focus();
            else cancelRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (pendingRef.current.length === 0) restoreFocusRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {current?.kind === 'prompt' && (
            <form id="viewer-prompt-form" onSubmit={(event: FormEvent) => { event.preventDefault(); finish(value); }}>
              <Label htmlFor="viewer-prompt-value">{t('viewerShell.dialog.promptValue')}</Label>
              <Input id="viewer-prompt-value" ref={inputRef} value={value} onChange={(event) => setValue(event.target.value)} />
            </form>
          )}
          <DialogFooter>
            <Button ref={cancelRef} variant="outline" onClick={() => finish(null)}>{t('viewerShell.dialog.cancel')}</Button>
            <Button
              ref={confirmRef}
              variant={current?.options.destructive ? 'destructive' : 'default'}
              type={current?.kind === 'prompt' ? 'submit' : 'button'}
              form={current?.kind === 'prompt' ? 'viewer-prompt-form' : undefined}
              onClick={current?.kind === 'confirm' ? () => finish(true) : undefined}
            >
              {current?.options.confirmLabel ?? t('viewerShell.dialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PortalContainerProvider>
  );
}
