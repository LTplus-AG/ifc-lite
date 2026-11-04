/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react';
import { Star, X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { useGitHubStarPrompt } from './useGitHubStarPrompt';

export function GitHubStarPrompt() {
  const { visible, dismiss } = useGitHubStarPrompt();
  const { t } = useTranslation();
  const card = useRef<HTMLElement>(null);
  const hovered = useRef(false);
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (!visible) return;
    const element = card.current;
    const enter = () => { hovered.current = true; };
    const leave = () => { hovered.current = false; };
    element?.addEventListener('pointerenter', enter);
    element?.addEventListener('pointerleave', leave);
    let remaining = 20_000;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (!hovered.current && !card.current?.contains(document.activeElement)) remaining -= now - previous;
      previous = now;
      if (remaining <= 0) dismissRef.current();
    }, 250);
    return () => {
      clearInterval(timer);
      element?.removeEventListener('pointerenter', enter);
      element?.removeEventListener('pointerleave', leave);
    };
  }, [visible]);
  if (!visible) return null;
  return (
    <aside ref={card} aria-label={t('viewerShell.star.title')}
      className="absolute bottom-14 right-4 z-20 w-70 max-w-full rounded-lg border bg-background p-3 shadow-md motion-safe:animate-in motion-safe:fade-in"
      >
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t('viewerShell.star.dismiss')}
        className="absolute right-1 top-1 text-muted-foreground"
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(); } }}
        onClick={dismiss}><X className="h-3.5 w-3.5" aria-hidden="true" /></Button>
      <p className="pr-6 text-sm font-medium">{t('viewerShell.star.title')}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t('viewerShell.star.detail')}</p>
      <a href="https://github.com/LTplus-AG/ifc-lite" target="_blank" rel="noopener noreferrer"
        onClick={dismiss}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(); } }}
        className="mt-2 inline-flex min-h-8 items-center gap-1.5 rounded text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Star className="h-3.5 w-3.5" aria-hidden="true" />{t('viewerShell.star.action')}
      </a>
    </aside>
  );
}
