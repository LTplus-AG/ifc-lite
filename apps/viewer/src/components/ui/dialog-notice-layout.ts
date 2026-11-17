/* SPDX-License-Identifier: MPL-2.0 */
import { useLayoutEffect, type RefObject } from 'react';

/** The shelf and caller's dialog are independent siblings in the portal. */
export function positionDialogNotices(shelf: HTMLElement): void {
  const panel = [...document.querySelectorAll<HTMLElement>('[data-dialog-panel]')]
    .find(element => element.dataset.dialogPanel === shelf.dataset.noticePanel);
  if (!panel) return;
  shelf.dataset.originalPaddingTop ??= panel.style.paddingTop;
  shelf.dataset.originalScrollPaddingTop ??= panel.style.scrollPaddingTop;
  const originalPadding = shelf.dataset.originalPaddingTop;
  const originalScrollPadding = shelf.dataset.originalScrollPaddingTop;
  let bounds = panel.getBoundingClientRect();
  const basePadding = Number.parseFloat(getComputedStyle(panel).paddingTop) - Number(panel.dataset.noticeInset ?? 0);
  shelf.style.width = `${bounds.width}px`;
  shelf.style.paddingRight = '0';
  const gap = 8;
  let needed = Math.min(shelf.scrollHeight, window.innerHeight * 0.3);
  const above = Math.max(0, bounds.top - gap - 16);
  const below = Math.max(0, window.innerHeight - bounds.bottom - gap - 16);
  const fallback = above < needed && below < needed;
  let left = bounds.left;
  let width = bounds.width;
  let top: number;
  if (fallback) {
    const inset = Math.max(8, basePadding);
    left += 8;
    width -= 16;
    Object.assign(shelf.style, { width: `${width}px`, paddingRight: '2rem' });
    needed = Math.min(shelf.scrollHeight, window.innerHeight * 0.3);
    const padding = inset + needed + gap;
    panel.style.paddingTop = `${padding}px`;
    panel.style.scrollPaddingTop = `${padding}px`;
    panel.dataset.noticeInset = String(padding - basePadding);
    bounds = panel.getBoundingClientRect();
    // Pin the fallback to the viewport edge of the panel, never its scrolled content.
    top = bounds.top + inset;
  } else {
    panel.style.paddingTop = originalPadding;
    panel.style.scrollPaddingTop = originalScrollPadding;
    delete panel.dataset.noticeInset;
    bounds = panel.getBoundingClientRect();
    top = above >= needed ? bounds.top - gap - needed : bounds.bottom + gap;
  }
  shelf.dataset.noticePlacement = fallback ? 'flow' : above >= needed ? 'above' : 'below';
  Object.assign(shelf.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, maxHeight: `${needed}px` });
}

export function useDialogNoticeLayout(panel: RefObject<HTMLDivElement | null>, shelf: RefObject<HTMLDivElement | null>, visible: boolean): void {
  useLayoutEffect(() => {
    const element = shelf.current;
    const content = panel.current;
    if (!visible || !element || !content) return;
    const padding = content.style.paddingTop;
    const scrollPadding = content.style.scrollPaddingTop;
    const update = () => positionDialogNotices(element);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(content);
    for (const region of element.children) observer.observe(region);
    window.addEventListener('resize', update);
    content.addEventListener('animationend', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      content.removeEventListener('animationend', update);
      content.style.paddingTop = padding;
      content.style.scrollPaddingTop = scrollPadding;
      delete content.dataset.noticeInset;
      delete element.dataset.originalPaddingTop;
      delete element.dataset.originalScrollPaddingTop;
      delete element.dataset.noticePlacement;
      for (const property of ['left', 'top', 'width', 'max-height', 'padding-right']) element.style.removeProperty(property);
    };
  }, [panel, shelf, visible]);
}
