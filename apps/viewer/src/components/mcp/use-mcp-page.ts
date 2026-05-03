/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tiny utilities shared by every landing-page variant:
 *
 *   • useFonts(href)   — injects a Google Fonts <link> only while a /mcp page
 *                        is mounted, so the global app stays unbothered.
 *   • useCopyToClipboard() — returns [copy, isJustCopied] for the install
 *                        snippets and recipe cards.
 *   • useDocumentMeta(title, themeColor)
 *                      — keeps <title> / theme-color in sync per variant.
 *
 * None of these touch React Suspense / global state — they’re plain
 * useEffect plumbing so the variants can be lifted out of the chooser
 * without surprises.
 */

import { useEffect, useState } from 'react';

/** Inject a stylesheet <link> while this hook is mounted. Idempotent. */
export function useFonts(...hrefs: string[]): void {
  useEffect(() => {
    const tags: HTMLLinkElement[] = [];
    for (const href of hrefs) {
      const existing = document.head.querySelector(`link[data-mcp-font="${href}"]`);
      if (existing) {
        // Already injected by another variant — refcount via a data attribute.
        const refs = Number(existing.getAttribute('data-refs') ?? '1') + 1;
        existing.setAttribute('data-refs', String(refs));
        tags.push(existing as HTMLLinkElement);
        continue;
      }
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.setAttribute('data-mcp-font', href);
      link.setAttribute('data-refs', '1');
      document.head.appendChild(link);
      tags.push(link);
    }
    return () => {
      for (const tag of tags) {
        const refs = Number(tag.getAttribute('data-refs') ?? '1') - 1;
        if (refs <= 0) tag.parentNode?.removeChild(tag);
        else tag.setAttribute('data-refs', String(refs));
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hrefs.join('|')]);
}

/** Browser-safe clipboard with a 1.4s "just copied" indicator. */
export function useCopyToClipboard(): {
  copy: (text: string, key?: string) => Promise<void>;
  copiedKey: string | null;
} {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  return {
    copiedKey,
    copy: async (text: string, key?: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopiedKey(key ?? text);
        setTimeout(() => setCopiedKey((curr) => (curr === (key ?? text) ? null : curr)), 1400);
      } catch {
        // Older browsers — fall through silently. The install dialogs always
        // show the snippet anyway so the user can manually select+copy.
      }
    },
  };
}

/** Set <title> + theme-color while mounted; restore on unmount. */
export function useDocumentMeta(title: string, themeColor?: string): void {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = title;
    let prevTheme: string | null = null;
    let themeMeta: HTMLMetaElement | null = null;
    if (themeColor) {
      themeMeta = document.querySelector('meta[name="theme-color"]');
      if (themeMeta) {
        prevTheme = themeMeta.getAttribute('content');
        themeMeta.setAttribute('content', themeColor);
      }
    }
    return () => {
      document.title = prevTitle;
      if (themeMeta && prevTheme !== null) themeMeta.setAttribute('content', prevTheme);
    };
  }, [title, themeColor]);
}

/** Smooth-scroll to an in-page anchor; updates the URL hash. */
export function scrollToAnchor(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  history.replaceState(null, '', `#${id}`);
}
