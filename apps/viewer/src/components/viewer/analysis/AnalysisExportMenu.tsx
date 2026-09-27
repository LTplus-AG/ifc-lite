/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The analysis export split button (#5834), extracted from the IDS panel's
 * report export: the main button exports in the last-used format, the chevron
 * picks another (which then becomes the default). A panel with one format gets
 * the main button alone.
 *
 * A format whose export needs a settings step (IDS → BCF, the Clash BCF
 * archive) opens its dialog from `onExport`; the panel owns that dialog.
 * Export is `Download` by the #5822 convention.
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, useHasTooltipProvider } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';

interface AnalysisExportFormat {
  id: string;
  /** Short name on the main button ("CSV"). */
  label: string;
  /** The full action: the main button's accessible name and tooltip ("Export the clash table as CSV"). */
  title: string;
  /** The row in the format menu ("CSV table"). */
  menuLabel?: string;
  icon?: ReactNode;
  onExport: () => void;
}

interface AnalysisExportMenuProps {
  formats: readonly AnalysisExportFormat[];
  disabled?: boolean;
  /** Icon-only main button, for a header row. */
  compact?: boolean;
  /** `data-*` attributes for the main button (a tour anchor). */
  buttonProps?: { [attribute: `data-${string}`]: string };
  className?: string;
}

export function AnalysisExportMenu({ formats, disabled = false, compact = false, buttonProps, className }: AnalysisExportMenuProps) {
  const { t } = useTranslation();
  const hasTooltipProvider = useHasTooltipProvider();
  const [lastId, setLastId] = useState(formats[0]?.id);
  const current = formats.find((f) => f.id === lastId) ?? formats[0];
  if (!current) return null;
  const split = formats.length > 1;

  const menu = (
    <div className={cn('flex items-center shrink-0', className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={compact ? 'ghost' : 'outline'}
            size="sm"
            className={cn(compact ? 'h-7 w-7 p-0' : 'h-7 gap-1.5 px-2 text-xs', split && 'rounded-r-none border-r-0')}
            aria-label={current.title}
            disabled={disabled}
            onClick={current.onExport}
            {...buttonProps}
          >
            <Download className={compact ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden="true" />
            {!compact && <span>{current.label}</span>}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{current.title}</TooltipContent>
      </Tooltip>
      {split && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={compact ? 'ghost' : 'outline'}
              size="sm"
              className="h-7 w-6 p-0 rounded-l-none"
              aria-label={t('analysisPanel.export.chooseFormat')}
              disabled={disabled}
            >
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {formats.map((format) => (
              <DropdownMenuItem
                key={format.id}
                onClick={() => {
                  setLastId(format.id);
                  format.onExport();
                }}
              >
                {format.icon && <span aria-hidden="true" className="mr-2 flex [&>svg]:h-4 [&>svg]:w-4">{format.icon}</span>}
                {format.menuLabel ?? format.label}
                {format.id === current.id && (
                  <span className="ml-auto text-xs text-muted-foreground">{t('analysisPanel.export.default')}</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
  // Like `IconButton`: a Radix Tooltip with no provider above it throws.
  return hasTooltipProvider ? menu : <TooltipProvider>{menu}</TooltipProvider>;
}
