/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useLayoutEffect, useCallback, lazy, Suspense } from 'react';
import { X, Sparkles, Info, Keyboard, ExternalLink, GraduationCap } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Dialog, DialogBody, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { LearnTab } from '@/components/tours/LearnTab';
import { navigateToPath } from '@/services/app-navigation';
import { useTranslation, type TranslationKey } from '@/i18n';
import { registerKeyboardCommand } from '@/lib/commands/dispatcher';
import { AboutTab } from './KeyboardShortcutsDialogTabs';
import { ShortcutsTab } from './ShortcutsTab';
import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary';

// Lazy: What's New inlines every package's release history (`__RELEASE_HISTORY__`,
// over 1 MB and growing with each release), so it must not sit in the eager bundle.
const WhatsNewTab = lazy(() => import('./KeyboardShortcutsWhatsNewTab').then(m => ({ default: m.WhatsNewTab })));

// Re-exported for `ViewportWelcomeCard.privacy.test.tsx` (#5119): the start
// screen renders the same banner and asserts it's the same component, not a
// second copy of the key.
export { PrivacyBanner } from './KeyboardShortcutsDialogTabs';

export type InfoDialogTab = 'about' | 'whatsnew' | 'shortcuts' | 'learn';

const TABS: ReadonlyArray<{ value: InfoDialogTab; Icon: typeof Info; label: TranslationKey }> = [
  { value: 'about', Icon: Info, label: 'keyboardShortcuts.tabs.about' },
  { value: 'whatsnew', Icon: Sparkles, label: 'keyboardShortcuts.tabs.whatsNew' },
  { value: 'shortcuts', Icon: Keyboard, label: 'keyboardShortcuts.tabs.shortcuts' },
  { value: 'learn', Icon: GraduationCap, label: 'keyboardShortcuts.tabs.learn' },
];
/** Tabs share the strip's width on a desktop and keep their label width
 *  when it is too narrow (the strip then scrolls); 44 px tall on a phone. */
const TAB_TRIGGER_CLASS = 'flex-auto shrink-0 gap-1.5 max-sm:min-h-11 data-[state=active]:bg-background data-[state=active]:text-foreground';
/** The scroll body: as tall as the content up to 24rem on a desktop, and
 *  whatever the capped dialog leaves on a phone. */
const TAB_BODY_CLASS = 'mt-0 p-4 sm:max-h-96';

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
      <DialogContent scrollBody hideCloseButton aria-describedby={undefined} className="gap-0 p-0 bg-card">
        {/* Header — the MCP CTA lives here, in line with the title, so
            it's a discoverable "what else can this do?" affordance
            without crowding the modeling toolbar. On a narrow screen its
            label truncates so the close button stays on the panel. */}
        <div className="flex shrink-0 items-center justify-between gap-2 p-4 border-b">
          <DialogTitle className="text-lg font-semibold shrink-0">{t('keyboardShortcuts.header.title')}</DialogTitle>
          <div className="flex items-center gap-1 min-w-0">
            <button
              type="button"
              onClick={() => { onClose(); navigateToPath('/mcp'); }}
              className="group inline-flex min-w-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 transition-colors px-3 py-1.5 text-xs font-medium text-primary"
              aria-label={t('keyboardShortcuts.header.mcpAriaLabel')}
            >
              <Sparkles className="h-3.5 w-3.5 shrink-0 group-hover:rotate-12 transition-transform" />
              <span className="truncate">{t('keyboardShortcuts.header.mcpCta')}</span>
              <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
            </button>
            <IconButton label={t('viewerShell.dialog.close')} variant="ghost" size="icon-sm" className="shrink-0" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>

        {/* Tabbed Content */}
        {/* The dialog unmounts when closed, so defaultValue re-applies on
            every open - enough for deep-linking without controlled tabs. */}
        <Tabs defaultValue={initialTab ?? 'about'} className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-4 pt-4">
            {/* Wider than a phone: the strip scrolls sideways, and the
                selected tab stays in view. */}
            <TabsList scrollable className="w-full justify-start max-sm:h-auto">
              {TABS.map(({ value, Icon, label }) => (
                <TabsTrigger key={value} value={value} className={TAB_TRIGGER_CLASS}>
                  <Icon className="h-3.5 w-3.5" />
                  {t(label)}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {/* One scroller for every tab, between a header and footer that
              stay put. Each wraps exactly one child — single-line, so a
              fifth tab (Preferences, #5509) didn't need a module-size
              budget raise. */}
          <DialogBody asChild><TabsContent value="about" className={TAB_BODY_CLASS}><AboutTab /></TabsContent></DialogBody>
          <DialogBody asChild><TabsContent value="whatsnew" className={TAB_BODY_CLASS}><ChunkErrorBoundary label="What's New tab"><Suspense fallback={null}><WhatsNewTab /></Suspense></ChunkErrorBoundary></TabsContent></DialogBody>
          <DialogBody asChild><TabsContent value="shortcuts" className={TAB_BODY_CLASS}><ShortcutsTab /></TabsContent></DialogBody>
          <DialogBody asChild><TabsContent value="learn" className={TAB_BODY_CLASS}><LearnTab onClose={onClose} /></TabsContent></DialogBody>
        </Tabs>

        {/* Footer */}
        <div className="shrink-0 p-4 border-t text-center">
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

  useLayoutEffect(() => {
    const toggleFromKey = () => {
      setTab('shortcuts');
      setOpen((value) => !value);
    };
    const removeGlobal = registerKeyboardCommand('help.shortcuts', toggleFromKey);
    // The same key closes its own modal; other global keys stay blocked.
    const removeModal = open
      ? registerKeyboardCommand('help.shortcuts', toggleFromKey, { layer: 'modal' })
      : () => {};
    return () => { removeGlobal(); removeModal(); };
  }, [open]);

  return { open, tab, toggle, close, openTab };
}
