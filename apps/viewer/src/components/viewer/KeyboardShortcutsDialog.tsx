/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useEffect, useCallback } from 'react';
import { X, Sparkles, Info, Keyboard, ExternalLink, GraduationCap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { LearnTab } from '@/components/tours/LearnTab';
import { navigateToPath } from '@/services/app-navigation';
import { useTranslation } from '@/i18n';
import { isTextEntryTarget } from '@/lib/keyboard-event';
import { AboutTab, ShortcutsTab } from './KeyboardShortcutsDialogTabs';
import { WhatsNewTab } from './KeyboardShortcutsWhatsNewTab';

// Re-exported for `ViewportWelcomeCard.privacy.test.tsx` (#5119): the start
// screen renders the same banner and asserts it's the same component, not a
// second copy of the key.
export { PrivacyBanner } from './KeyboardShortcutsDialogTabs';

export type InfoDialogTab = 'about' | 'whatsnew' | 'shortcuts' | 'learn';

interface InfoDialogProps {
  open: boolean;
  onClose: () => void;
  /** Tab shown when the dialog opens (deep link, e.g. the Learn hub). */
  initialTab?: InfoDialogTab;
}

/**
 * The shell moved onto `ui/dialog.tsx` (Radix) for #5817: it previously had
 * no `role="dialog"`, no focus trap, and no focus return to the opener on
 * close — all of which `DialogContent` supplies. The tab bodies are
 * unchanged (`KeyboardShortcutsDialogTabs.tsx`), and so is the header/footer
 * markup; only the outer `fixed inset-0` div and the manual `window`
 * `keydown` Escape listener are gone, both superseded by Radix.
 */
export function KeyboardShortcutsDialog({ open, onClose, initialTab }: InfoDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      {/* `bg-card` (not `DialogContent`'s default `bg-background`) preserves
          the panel's pre-existing surface token exactly — the two diverge in
          both dark and colorful themes (`index.css`), and the contrast suite
          (`panel-secondary-text.test.ts`'s `KEYBOARD_SHORTCUTS_DIALOG_SURFACE`)
          is pinned to it. */}
      {/* No `DialogDescription`: the tabbed content itself is the body, not
          a single describable summary, and this dialog isn't a confirm/alert
          prompt that needs one. `aria-describedby={undefined}` opts out
          explicitly (CodeRabbit, #5817 review) rather than leaving it
          unset, which some Radix versions read as "forgot to wire one up"
          and warn about in dev. */}
      <DialogContent hideCloseButton aria-describedby={undefined} className="max-w-md w-full gap-0 p-0 bg-card">
        {/* Header — the MCP CTA lives here, in line with the title, so
            it's a discoverable "what else can this do?" affordance
            without crowding the modeling toolbar. */}
        <div className="flex items-center justify-between gap-2 p-4 border-b">
          <DialogTitle className="text-lg font-semibold shrink-0">{t('keyboardShortcuts.header.title')}</DialogTitle>
          <div className="flex items-center gap-1 min-w-0">
            <button
              type="button"
              onClick={() => { onClose(); navigateToPath('/mcp'); }}
              className="group inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 transition-colors px-3 py-1.5 text-xs font-medium text-primary"
              aria-label={t('keyboardShortcuts.header.mcpAriaLabel')}
            >
              <Sparkles className="h-3.5 w-3.5 group-hover:rotate-12 transition-transform" />
              <span className="whitespace-nowrap">{t('keyboardShortcuts.header.mcpCta')}</span>
              <ExternalLink className="h-3 w-3 opacity-60" />
            </button>
            <Button variant="ghost" size="icon-sm" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Tabbed Content */}
        {/* The dialog unmounts when closed, so defaultValue re-applies on
            every open - enough for deep-linking without controlled tabs. */}
        <Tabs defaultValue={initialTab ?? 'about'} className="w-full">
          <div className="px-4 pt-4">
            <TabsList className="w-full">
              <TabsTrigger value="about" className="flex-1 gap-1.5 data-[state=active]:bg-background data-[state=active]:text-foreground">
                <Info className="h-3.5 w-3.5" />
                {t('keyboardShortcuts.tabs.about')}
              </TabsTrigger>
              <TabsTrigger value="whatsnew" className="flex-1 gap-1.5 data-[state=active]:bg-background data-[state=active]:text-foreground">
                <Sparkles className="h-3.5 w-3.5" />
                {t('keyboardShortcuts.tabs.whatsNew')}
              </TabsTrigger>
              <TabsTrigger value="shortcuts" className="flex-1 gap-1.5 data-[state=active]:bg-background data-[state=active]:text-foreground">
                <Keyboard className="h-3.5 w-3.5" />
                {t('keyboardShortcuts.tabs.shortcuts')}
              </TabsTrigger>
              <TabsTrigger value="learn" className="flex-1 gap-1.5 data-[state=active]:bg-background data-[state=active]:text-foreground">
                <GraduationCap className="h-3.5 w-3.5" />
                {t('keyboardShortcuts.tabs.learn')}
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Each wraps exactly one child — single-line, so a fifth tab
              (Preferences, #5509) didn't need a module-size budget raise. */}
          <TabsContent value="about" className="p-4 max-h-80 overflow-y-auto"><AboutTab /></TabsContent>
          <TabsContent value="whatsnew" className="p-4 max-h-96 overflow-y-auto"><WhatsNewTab /></TabsContent>
          <TabsContent value="shortcuts" className="p-4 max-h-80 overflow-y-auto"><ShortcutsTab /></TabsContent>
          <TabsContent value="learn" className="p-4 max-h-80 overflow-y-auto"><LearnTab onClose={onClose} /></TabsContent>
        </Tabs>

        {/* Footer */}
        <div className="p-4 border-t text-center">
          <span className="text-xs text-muted-foreground">
            {t('keyboardShortcuts.footer.pressPrefix')}{' '}
            <kbd className="px-1 py-0.5 bg-muted rounded border font-mono text-xs">
              ?
            </kbd>{' '}
            {t('keyboardShortcuts.footer.toggleSuffix')}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Hook to manage info dialog state (renamed export for backward compatibility)
export function useKeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<InfoDialogTab | undefined>(undefined);

  const toggle = useCallback(() => {
    setTab(undefined);
    setOpen((o) => !o);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  /** Deep-link open on a specific tab (e.g. the Learn hub). Always opens. */
  const openTab = useCallback((next: InfoDialogTab) => {
    setTab(next);
    setOpen(true);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTextEntryTarget(e)) return;
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        setTab('shortcuts'); // `?` is the documented shortcuts key: open there, not on About
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return { open, tab, toggle, close, openTab };
}
