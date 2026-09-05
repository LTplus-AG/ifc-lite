/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDSReportExportButton - the split "Export report" control in IDSPanel's
 * toolbar: a direct-export button remembering the last-used format, plus a
 * dropdown to switch format (HTML/JSON/BCF). BCF export routes through the
 * controlled `IDSExportDialog` since it needs a settings step.
 */

import { useCallback, useState } from 'react';
import {
  ChevronDown,
  Download,
  FileCode,
  FileJson,
  FileBox,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useIDS } from '@/hooks/useIDS';
import { IDSExportDialog } from './IDSExportDialog';
import type { IDSBCFExportSettings, IDSExportProgress } from './IDSExportDialog';

type ExportFormat = 'html' | 'json' | 'bcf';

const FORMAT_LABELS: Record<ExportFormat, string> = {
  html: 'HTML',
  json: 'JSON',
  bcf: 'BCF',
};

interface ReportExportButtonProps {
  onExportJSON: () => void;
  onExportHTML: () => void;
  onExportBCF: (settings: IDSBCFExportSettings) => Promise<void>;
  bcfExportProgress: IDSExportProgress | null;
  report: ReturnType<typeof useIDS>['report'];
}

export function ReportExportButton({
  onExportJSON,
  onExportHTML,
  onExportBCF,
  bcfExportProgress,
  report,
}: ReportExportButtonProps) {
  const [lastFormat, setLastFormat] = useState<ExportFormat>('html');
  const [bcfDialogOpen, setBcfDialogOpen] = useState(false);

  const handleDirectExport = useCallback(() => {
    if (lastFormat === 'html') onExportHTML();
    else if (lastFormat === 'json') onExportJSON();
    else setBcfDialogOpen(true);
  }, [lastFormat, onExportHTML, onExportJSON]);

  const handleSelectFormat = useCallback((format: ExportFormat) => {
    setLastFormat(format);
    if (format === 'html') onExportHTML();
    else if (format === 'json') onExportJSON();
    else setBcfDialogOpen(true);
  }, [onExportHTML, onExportJSON]);

  const label = FORMAT_LABELS[lastFormat];

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center">
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 rounded-r-none border-r-0 gap-1.5"
              onClick={handleDirectExport}
            >
              <Download className="h-3.5 w-3.5" />
              <span className="text-xs">{label}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-6 p-0 rounded-l-none"
                  aria-label="Choose report format"
                >
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => handleSelectFormat('html')}>
                  <FileCode className="h-4 w-4 text-orange-500 mr-2" />
                  HTML Report
                  {lastFormat === 'html' && <span className="ml-auto text-xs text-muted-foreground">default</span>}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleSelectFormat('json')}>
                  <FileJson className="h-4 w-4 text-blue-500 mr-2" />
                  JSON Report
                  {lastFormat === 'json' && <span className="ml-auto text-xs text-muted-foreground">default</span>}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => handleSelectFormat('bcf')}>
                  <FileBox className="h-4 w-4 text-green-500 mr-2" />
                  BCF Report...
                  {lastFormat === 'bcf' && <span className="ml-auto text-xs text-muted-foreground">default</span>}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TooltipTrigger>
        <TooltipContent>Export Report ({label})</TooltipContent>
      </Tooltip>

      {/* BCF Export Dialog (controlled open) */}
      <IDSExportDialog
        hasReport={!!report}
        failedCount={report?.specificationResults.reduce((sum, s) => sum + s.failedCount, 0) ?? 0}
        onExport={onExportBCF}
        progress={bcfExportProgress}
        open={bcfDialogOpen}
        onOpenChange={setBcfDialogOpen}
      />
    </>
  );
}
