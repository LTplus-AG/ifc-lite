/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Slot, Slottable } from '@radix-ui/react-slot';
import { X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { usePortalContainer } from './portal-container';
import { Dialog, useToastDialog } from './dialog-root';
import { moveNoticeFocus } from './dialog-notice-interactions';
import { useDialogNoticeLayout } from './dialog-notice-layout';
import { ToastMessages, useToastItems } from './toast';
import { refreshToastDialogs, registerToastDialog } from './toast-store';

const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-scrim/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * `scrollBody` (#8802): a dialog whose content can outgrow the screen. The
 * dialog is capped at the viewport, with a 1rem margin on every side, and
 * becomes a column: header and footer keep their height, and the one
 * `DialogBody` takes the rest and scrolls. As flex items its parts are as
 * wide as the dialog; a grid track would grow to the widest unbreakable
 * row and push content past the panel (the Info dialog's Learn tab).
 * The default layout is a grid whose rows are not height-limited, so a capped
 * grid dialog clips its body instead of scrolling it (Settings on a phone).
 */
const DIALOG_SCROLL_BODY_LAYOUT = 'flex flex-col w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] overflow-hidden';

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideCloseButton?: boolean; overlayClassName?: string; scrollBody?: boolean;
    /** Keep scroll-dialog content within the viewport without changing its max-width. */
    viewportBounds?: 'height' | 'both';
  }
>(({ className, children, hideCloseButton, overlayClassName, scrollBody, viewportBounds, asChild, onPointerDownOutside, onInteractOutside, onFocusOutside, onKeyDownCapture, onFocusCapture, onBlurCapture, ...props }, ref) => {
  const { t } = useTranslation();
  const owner = useToastDialog();
  // Only mounted panels own notices. Register before descendant layout effects;
  // registration is silent, with React subscribers notified in the layout phase.
  React.useInsertionEffect(() => {
    if (owner.open && owner.modal) return registerToastDialog(owner.id, owner.ancestors);
  }, [owner.id, owner.ancestors, owner.open, owner.modal]);
  React.useLayoutEffect(() => {
    if (!owner.open || !owner.modal) return;
    refreshToastDialogs();
    return refreshToastDialogs;
  }, [owner.id, owner.ancestors, owner.open, owner.modal]);
  const notices = useToastItems().filter(item => owner.modal && owner.open && item.dialogId === owner.id);
  const noticeShelf = React.useRef<HTMLDivElement>(null);
  const panel = React.useRef<HTMLDivElement>(null);
  const shelfFocused = React.useRef(false);
  const noticePointers = React.useRef(new WeakSet<Event>());
  const contentRef = React.useCallback((node: HTMLDivElement | null) => {
    panel.current = node;
    if (typeof ref === 'function') return ref(node);
    if (ref) ref.current = node;
  }, [ref]);
  useDialogNoticeLayout(panel, noticeShelf, notices.length > 0);
  React.useLayoutEffect(() => {
    const content = panel.current;
    if (!owner.open) shelfFocused.current = false;
    else if (content && shelfFocused.current && (!notices.length || content.ownerDocument.activeElement === content.ownerDocument.body)) {
      shelfFocused.current = false;
      const next = noticeShelf.current?.querySelector<HTMLButtonElement>('[data-toast-seq] > button:last-child');
      (next ?? content).focus({ preventScroll: true });
    }
  }, [notices, owner.open]);
  const isNoticeTarget = (target: EventTarget | null) => target instanceof Node && noticeShelf.current?.contains(target);
  const isNoticeInteraction = (event: { target: EventTarget | null; detail: { originalEvent: Event } }) =>
    isNoticeTarget(event.target) || noticePointers.current.has(event.detail.originalEvent);
  const shelfId = `dialog-notices-${owner.id}`;
  return (
  <DialogPortal container={usePortalContainer()}>
    <DialogOverlay className={overlayClassName} />
    <DialogPrimitive.Content
      {...props}
      ref={contentRef}
      asChild={asChild}
      data-dialog-panel={owner.id}
      aria-owns={[props['aria-owns'], notices.length ? shelfId : undefined].filter(Boolean).join(' ') || undefined}
      onPointerDownOutside={event => { if (isNoticeInteraction(event)) event.preventDefault(); else onPointerDownOutside?.(event); }}
      onInteractOutside={event => { if (isNoticeInteraction(event)) event.preventDefault(); else onInteractOutside?.(event); }}
      onFocusOutside={event => { if (isNoticeInteraction(event)) event.preventDefault(); else onFocusOutside?.(event); }}
      onFocusCapture={event => { shelfFocused.current = false; onFocusCapture?.(event); }}
      onBlurCapture={event => {
        onBlurCapture?.(event);
        if (isNoticeTarget(event.relatedTarget)) event.stopPropagation();
      }}
      onKeyDownCapture={event => { onKeyDownCapture?.(event); moveNoticeFocus(event, panel.current, noticeShelf.current); }}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg',
        // Apply the default cap before any notice arrives, so it cannot recenter the panel.
        scrollBody ? DIALOG_SCROLL_BODY_LAYOUT : 'max-h-[calc(100dvh-2rem)] overflow-y-auto',
        viewportBounds && 'max-h-[85dvh]',
        viewportBounds === 'both' && 'w-[calc(100%-2rem)]',
        className
      )}
    >
      {asChild ? <Slottable>{children}</Slottable> : children}
      {!hideCloseButton && (
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
          <X className="h-4 w-4" />
          <span className="sr-only">{t('viewerShell.dialog.close')}</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
    {owner.modal && (
      // This overlay supplies scroll allowance for the sibling shelf as well as Content.
      <DialogPrimitive.Overlay asChild>
        <div ref={noticeShelf} id={shelfId} data-notice-shelf data-notice-panel={owner.id}
          data-dialog-notices={notices.length ? '' : undefined}
          className={notices.length ? 'fixed z-50 min-w-0 max-h-[30dvh] overflow-y-auto' : 'sr-only pointer-events-none'}
          style={{ pointerEvents: 'none' }}
          onPointerDownCapture={event => {
            // Outside dispatch is deferred; dismiss can remove the target before pointerup.
            noticePointers.current.add(event.nativeEvent);
          }}
          onFocusCapture={event => {
            shelfFocused.current = true;
            // Radix's panel focus trap must not recapture focus from this allowed sibling.
            event.stopPropagation();
          }}
          onBlurCapture={event => { if (isNoticeTarget(event.relatedTarget)) event.stopPropagation(); }}
          onKeyDownCapture={event => moveNoticeFocus(event, panel.current, noticeShelf.current)}>
          <ToastMessages items={notices} insideDialog />
        </div>
      </DialogPrimitive.Overlay>
    )}
  </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col space-y-1.5 text-center sm:text-left',
      className
    )}
    {...props}
  />
);
DialogHeader.displayName = 'DialogHeader';

/** The scrolling region of a `scrollBody` dialog: it takes the height the
 *  header and footer leave and is the dialog's only scroller. `asChild`
 *  puts those classes on the child instead (a `TabsContent`, say). */
const DialogBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { asChild?: boolean }
>(({ className, asChild, ...props }, ref) => {
  const Comp = asChild ? Slot : 'div';
  return <Comp ref={ref} className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)} {...props} />;
});
DialogBody.displayName = 'DialogBody';

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2',
      className
    )}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      'text-lg font-semibold leading-none tracking-tight',
      className
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
