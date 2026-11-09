/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Settings (#5857): the one home for viewer preferences, one section per
 * topic. `SettingsDialogHost` is mounted once by `ViewerLayout` and opens on
 * `openSettings(section?)` (see `lib/settings/open-settings.ts`).
 */

import { useEffect, useState, useSyncExternalStore, type ComponentType } from 'react';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  EVENT_OPEN_SETTINGS,
  SETTINGS_SECTIONS,
  type OpenSettingsDetail,
  type SettingsSection,
} from '@/lib/settings/open-settings';
import { GeneralSection } from './GeneralSection';
import { DisplaySection } from './DisplaySection';
import { PerformanceSection } from './PerformanceSection';
import { PrivacyPanel } from '@/components/extensions/PrivacyPanel';
import { CollaborationSection } from './CollaborationSection';

const SECTIONS: Record<SettingsSection, { label: TranslationKey; Body: ComponentType }> = {
  general: { label: 'settings.sections.general', Body: GeneralSection },
  display: { label: 'settings.sections.display', Body: DisplaySection },
  performance: { label: 'settings.sections.performance', Body: PerformanceSection },
  privacy: { label: 'settings.sections.privacy', Body: PrivacyPanel },
  collaboration: { label: 'settings.sections.collaboration', Body: CollaborationSection },
};

export interface SettingsDialogProps {
  open: boolean;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onOpenChange: (open: boolean) => void;
}

/** Tailwind's `sm` breakpoint, in the same unit Tailwind uses (`40rem`): below
 *  it the section list is a horizontal strip, so arrow keys follow its
 *  orientation. A `rem` in a media query follows the browser's default font
 *  size, as the CSS does; a px query would disagree between 640 and 800 px at
 *  a 20 px default (#8802 review). */
const SM_QUERY = '(min-width: 40rem)';

function subscribeSm(onChange: () => void): () => void {
  const query = window.matchMedia?.(SM_QUERY);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}

function isSmViewport(): boolean {
  return window.matchMedia?.(SM_QUERY).matches ?? true;
}

/**
 * Phone (below `sm`, #8802): the sections are one horizontally scrolling tab
 * strip under the header, each tab a 44 px target, the selected one in the
 * R4 active state, and the edge that hides more tabs fades (`TabsList
 * scrollable`). Its classes carry `!` so they win over the theme rules that
 * repaint every `[data-state="active"]` in dark and colorful.
 * Desktop keeps the vertical side list.
 */
const TAB_LIST_CLASS = 'flex h-auto w-full shrink-0 justify-start gap-1 rounded-none border-b bg-transparent px-3 py-1.5 sm:w-40 sm:flex-col sm:items-stretch sm:overflow-visible sm:border-b-0 sm:p-0';
const TAB_TRIGGER_CLASS = 'min-h-11 shrink-0 justify-start px-3 data-[state=active]:font-medium data-[state=active]:shadow-none max-sm:data-[state=active]:bg-active-surface! max-sm:data-[state=active]:text-active! max-sm:data-[state=active]:ring-1 max-sm:data-[state=active]:ring-inset max-sm:data-[state=active]:ring-active-border sm:min-h-0 sm:data-[state=active]:bg-muted sm:data-[state=active]:text-foreground';

/**
 * Desktop keeps a steady height across sections: the 20rem body floor it had
 * before, plus the 67 px header and the 2 px border. The floor sits on the
 * dialog and is capped at the dialog's own viewport limit. A floor on the body
 * could outgrow a short window and push the body's end past the dialog's
 * clipped bottom (#8802 review).
 */
const DIALOG_CLASS = 'max-w-2xl gap-0 p-0 sm:min-h-[min(calc(20rem+69px),calc(100dvh-2rem))]';

export function SettingsDialog({ open, section, onSectionChange, onOpenChange }: SettingsDialogProps) {
  const { t } = useTranslation();
  const wide = useSyncExternalStore(subscribeSm, isSmViewport, () => true);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent scrollBody className={DIALOG_CLASS} data-settings-dialog>
        <div className="shrink-0 border-b px-5 pb-3 pt-5">
          <DialogTitle>{t('settings.title')}</DialogTitle>
          <DialogDescription className="text-xs">{t('settings.description')}</DialogDescription>
        </div>
        <Tabs
          orientation={wide ? 'vertical' : 'horizontal'}
          value={section}
          onValueChange={(value) => { const next = SETTINGS_SECTIONS.find((id) => id === value); if (next) onSectionChange(next); }}
          className="flex min-h-0 flex-1 flex-col sm:flex-row sm:gap-4 sm:px-5 sm:pb-5 sm:pt-3"
        >
          <TabsList scrollable className={TAB_LIST_CLASS}>
            {SETTINGS_SECTIONS.map((id) => (
              <TabsTrigger key={id} value={id} className={TAB_TRIGGER_CLASS}>
                {t(SECTIONS[id].label)}
              </TabsTrigger>
            ))}
          </TabsList>
          {SETTINGS_SECTIONS.map((id) => {
            const { Body } = SECTIONS[id];
            return (
              <DialogBody key={id} asChild>
                <TabsContent value={id} className="mt-0 min-w-0 px-5 pb-5 pt-3 sm:max-h-[60vh] sm:p-0">
                  <Body />
                </TabsContent>
              </DialogBody>
            );
          })}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** The mounted instance: opens on `openSettings()`, on the section it names. */
export function SettingsDialogHost() {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>(SETTINGS_SECTIONS[0]);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const requested = (e as CustomEvent<OpenSettingsDetail | undefined>).detail?.section;
      setSection(requested ?? SETTINGS_SECTIONS[0]);
      setOpen(true);
    };
    window.addEventListener(EVENT_OPEN_SETTINGS, onOpen);
    return () => window.removeEventListener(EVENT_OPEN_SETTINGS, onOpen);
  }, []);
  return <SettingsDialog open={open} section={section} onSectionChange={setSection} onOpenChange={setOpen} />;
}
