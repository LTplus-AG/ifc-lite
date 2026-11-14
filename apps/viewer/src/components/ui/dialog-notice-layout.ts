/* SPDX-License-Identifier: MPL-2.0 */
import { useLayoutEffect, type RefObject } from 'react';

/** Keep the shelf in the modal DOM, but outside its interactive content box. */
export function positionDialogNotices(shelf: HTMLElement): void {
  const panel = shelf.parentElement;
  if (!panel) return;
  // Measure the original content box even after a previous capped fallback.
  shelf.style.position = 'absolute';
  const bounds = panel.getBoundingClientRect();
  const gap = 8;
  const margin = 16;
  const above = Math.max(0, bounds.top - gap - margin);
  const below = Math.max(0, window.innerHeight - bounds.bottom - gap - margin);
  const needed = Math.min(shelf.scrollHeight, window.innerHeight * 0.3);
  const cap = Number.parseFloat(getComputedStyle(panel).maxHeight);
  // Only a panel already at its cap may trade body space for an in-flow shelf.
  const atCap = Number.isFinite(cap) && bounds.height >= cap - 1;
  const inFlow = above < needed && below < needed && atCap;
  const onTop = above >= needed || (below < needed && above >= below);
  shelf.dataset.noticePlacement = inFlow ? 'flow' : onTop ? 'above' : 'below';
  Object.assign(shelf.style, {
    position: inFlow ? 'relative' : 'absolute',
    top: inFlow ? 'auto' : onTop ? 'auto' : '100%',
    bottom: inFlow ? 'auto' : onTop ? '100%' : 'auto',
    marginTop: !inFlow && !onTop ? `${gap}px` : '0',
    marginBottom: !inFlow && onTop ? `${gap}px` : '0',
    maxHeight: `${inFlow ? window.innerHeight * 0.3 : Math.min(needed, onTop ? above : below)}px`,
  });
  // An out-of-box shelf must escape both scrollBody clipping and default scrolling.
  // The body remains the scroller in scrollBody dialogs. Restore clipping at the cap.
  panel.style.overflow = inFlow ? '' : 'visible';
}

export function useDialogNoticeLayout(shelf: RefObject<HTMLDivElement | null>, visible: boolean): void {
  useLayoutEffect(() => {
    const element = shelf.current;
    const panel = element?.parentElement;
    if (!visible || !element || !panel) return;
    const overflow = panel.style.overflow;
    const update = () => {
      positionDialogNotices(element);
      if (element.dataset.noticePlacement === 'flow') panel.style.overflow = overflow;
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(panel);
    window.addEventListener('resize', update);
    panel.addEventListener('animationend', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      panel.removeEventListener('animationend', update);
      panel.style.overflow = overflow;
      element.removeAttribute('style');
      delete element.dataset.noticePlacement;
    };
  }, [shelf, visible]);
}
