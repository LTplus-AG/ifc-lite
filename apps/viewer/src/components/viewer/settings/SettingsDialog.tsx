/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Settings (#5857): the one home for viewer preferences, one section per
 * topic. `SettingsDialogHost` is mounted once by `ViewerLayout` and opens on
 * `openSettings(section?)` (see `lib/settings/open-settings.ts`).
 */

import { useEffect, useState, type ComponentType } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
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

export function SettingsDialog({ open, section, onSectionChange, onOpenChange }: SettingsDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-3 p-0" data-settings-dialog>
        <div className="border-b px-5 pb-3 pt-5">
          <DialogTitle>{t('settings.title')}</DialogTitle>
          <DialogDescription className="text-xs">{t('settings.description')}</DialogDescription>
        </div>
        <Tabs
          orientation="vertical"
          value={section}
          onValueChange={(value) => { const next = SETTINGS_SECTIONS.find((id) => id === value); if (next) onSectionChange(next); }}
          className="flex min-h-[20rem] gap-4 px-5 pb-5"
        >
          <TabsList className="flex h-auto w-40 shrink-0 flex-col items-stretch justify-start gap-1 bg-transparent p-0">
            {SETTINGS_SECTIONS.map((id) => (
              <TabsTrigger key={id} value={id} className="justify-start data-[state=active]:bg-muted data-[state=active]:font-medium data-[state=active]:text-foreground">
                {t(SECTIONS[id].label)}
              </TabsTrigger>
            ))}
          </TabsList>
          {SETTINGS_SECTIONS.map((id) => {
            const { Body } = SECTIONS[id];
            return (
              <TabsContent key={id} value={id} className="mt-0 max-h-[60vh] min-w-0 flex-1 overflow-y-auto">
                <Body />
              </TabsContent>
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
