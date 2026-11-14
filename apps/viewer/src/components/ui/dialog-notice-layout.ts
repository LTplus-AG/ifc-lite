/* SPDX-License-Identifier: MPL-2.0 */
import { useLayoutEffect, type RefObject } from 'react';

/** Fixed viewport placement in an untransformed Radix scope, beside the panel. */
export function positionDialogNotices(shelf: HTMLElement): void {
  const scope = shelf.parentElement;
  const panel = scope?.querySelector<HTMLElement>('[data-dialog-panel]');
  const slot = panel?.querySelector<HTMLElement>('[data-dialog-notice-slot]');
  if (!panel || !slot) return;
  // The fallback reserves space; it never changes the panel's overflow rules.
  slot.style.display = 'none';
  let bounds = panel.getBoundingClientRect();
  shelf.style.width = `${bounds.width}px`;
  const gap = 8;
  const margin = 16;
  const above = Math.max(0, bounds.top - gap - margin);
  const below = Math.max(0, window.innerHeight - bounds.bottom - gap - margin);
  const needed = Math.min(shelf.scrollHeight, window.innerHeight * 0.3);
  const inFlow = above < needed && below < needed;
  const onTop = above >= needed;
  let left = bounds.left;
  let top = onTop ? bounds.top - gap - needed : bounds.bottom + gap;
  let width = bounds.width;
  let clipPath = 'none';
  if (inFlow) {
    Object.assign(slot.style, { display: 'block', height: `${needed}px` });
    bounds = panel.getBoundingClientRect();
    const reserved = slot.getBoundingClientRect();
    left = reserved.left;
    top = reserved.top;
    width = reserved.width;
    // The shelf remains a scope sibling. Clip its reserved row while the panel scrolls.
    clipPath = `inset(${Math.max(0, bounds.top - top)}px 0 ${Math.max(0, top + needed - bounds.bottom)}px 0)`;
  }
  shelf.dataset.noticePlacement = inFlow ? 'flow' : onTop ? 'above' : 'below';
  Object.assign(shelf.style, {
    position: 'fixed', left: `${left}px`, top: `${top}px`, width: `${width}px`,
    maxHeight: `${needed}px`, clipPath, paddingRight: inFlow ? '2rem' : '0',
  });
}

export function useDialogNoticeLayout(shelf: RefObject<HTMLDivElement | null>, visible: boolean): void {
  useLayoutEffect(() => {
    const element = shelf.current;
    const panel = element?.parentElement?.querySelector<HTMLElement>('[data-dialog-panel]');
    const slot = panel?.querySelector<HTMLElement>('[data-dialog-notice-slot]');
    if (!visible || !element || !panel || !slot) return;
    const update = () => positionDialogNotices(element);
    const reveal = () => {
      if (element.dataset.noticePlacement === 'flow') slot.scrollIntoView({ block: 'nearest' });
      update();
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(panel);
    for (const region of element.children) observer.observe(region);
    window.addEventListener('resize', update);
    panel.addEventListener('animationend', update);
    panel.addEventListener('scroll', update, true);
    element.addEventListener('focusin', reveal);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      panel.removeEventListener('animationend', update);
      panel.removeEventListener('scroll', update, true);
      element.removeEventListener('focusin', reveal);
      slot.style.display = 'none';
      element.removeAttribute('style');
      delete element.dataset.noticePlacement;
    };
  }, [shelf, visible]);
}
