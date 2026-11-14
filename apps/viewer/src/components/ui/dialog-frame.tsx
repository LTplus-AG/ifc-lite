/* SPDX-License-Identifier: MPL-2.0 */
import * as React from 'react';

/** Radix owns this untransformed focus/dismiss scope. The visual panel and
 * fixed shelf are siblings, so the panel can keep its own scrolling/clipping. */
export const DialogFrame = React.forwardRef<HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    panelRef: React.ForwardedRef<HTMLDivElement>;
    notices: React.ReactNode;
  }
>(({ panelRef, notices, children, onKeyDown, onPointerDownCapture, onFocusCapture, onBlurCapture,
  tabIndex, style, ...panelProps }, scopeRef) => (
  // Radix capture handlers belong to this nonvisual focus scope, not an interactive control.
  // eslint-disable-next-line jsx-a11y/no-static-element-interactions
  <div ref={scopeRef} data-dialog-scope className="fixed inset-0 z-50 pointer-events-none"
    tabIndex={-1} onKeyDown={onKeyDown} onPointerDownCapture={onPointerDownCapture}
    onFocusCapture={onFocusCapture} onBlurCapture={onBlurCapture}>
    <div {...panelProps} data-dialog-panel ref={panelRef} tabIndex={tabIndex}
      style={{ ...style, pointerEvents: style?.pointerEvents ?? 'auto' }}>
      <div data-dialog-notice-slot style={{ display: 'none' }} />
      {children}
    </div>
    {notices}
  </div>
));
DialogFrame.displayName = 'DialogFrame';
