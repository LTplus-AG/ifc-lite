/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDSPanel - IDS (Information Delivery Specification) validation panel
 *
 * Provides:
 * - Load IDS files
 * - Run validation against loaded models
 * - View validation results with pass/fail status
 * - Filter by specification, status
 * - Click to select entities in 3D view
 * - Isolate failed/passed entities
 * - Multi-language support (EN/DE/FR)
 */

import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import {
  X,
  Upload,
  Play,
  CheckCircle,
  XCircle,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Filter,
  Focus,
  EyeOff,
  Eye,
  FileText,
  Loader2,
  Building2,
  RefreshCw,
  Trash2,
  FileJson,
  FileCode,
  FileBox,
  Download,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useIDS } from '@/hooks/useIDS';
import { openGenericFileDialog } from '@/services/file-dialog';
import type {
  IDSSpecificationResult,
  IDSEntityResult,
  IDSRequirementResult,
} from '@ifc-lite/ids';
import { cn } from '@/lib/utils';
import { IDSAuditSummary } from './IDSAuditSummary';
import { IDSExportDialog } from './IDSExportDialog';
import type { IDSBCFExportSettings, IDSExportProgress } from './IDSExportDialog';
import { claimNextDesktopPanelAction, subscribeDesktopPanelActions } from '@/services/desktop-panel-actions';

// ============================================================================
// Types
// ============================================================================

interface IDSPanelProps {
  onClose?: () => void;
}

// ============================================================================
// Helper Components
// ============================================================================

function StatusIcon({ status, showLabel = false }: { status: 'pass' | 'fail' | 'not_applicable'; showLabel?: boolean }) {
  const labels = {
    pass: 'Passed',
    fail: 'Failed',
    not_applicable: 'Not Applicable',
  };

  const icons = {
    pass: <CheckCircle className="h-4 w-4 text-green-500" aria-hidden="true" />,
    fail: <XCircle className="h-4 w-4 text-red-500" aria-hidden="true" />,
    not_applicable: <AlertCircle className="h-4 w-4 text-yellow-500" aria-hidden="true" />,
  };

  return (
    <span className="inline-flex items-center gap-1" role="status" aria-label={labels[status]}>
      {icons[status]}
      {showLabel && <span className="sr-only">{labels[status]}</span>}
    </span>
  );
}

function StatusBadge({ status }: { status: 'pass' | 'fail' | 'not_applicable' }) {
  const variant = status === 'pass' ? 'default' : status === 'fail' ? 'destructive' : 'secondary';
  const label = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'N/A';

  return (
    <Badge variant={variant} className="text-xs">
      {label}
    </Badge>
  );
}

function PassRateBar({ passRate }: { passRate: number }) {
  const color = passRate >= 80 ? 'bg-green-500' : passRate >= 50 ? 'bg-yellow-500' : 'bg-red-500';

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', color)}
          style={{ width: `${passRate}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground w-10 text-right">{passRate}%</span>
    </div>
  );
}

// ============================================================================
// Specification Card Component
// ============================================================================

interface SpecificationCardProps {
  result: IDSSpecificationResult;
  isActive: boolean;
  onSelect: () => void;
  onEntityClick: (modelId: string, expressId: number) => void;
  filterMode: 'all' | 'failed' | 'passed';
}

function SpecificationCard({
  result,
  isActive,
  onSelect,
  onEntityClick,
  filterMode,
}: SpecificationCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Filter entity results based on mode
  const filteredEntities = useMemo(() => {
    if (filterMode === 'all') return result.entityResults;
    return result.entityResults.filter((e) =>
      filterMode === 'failed' ? !e.passed : e.passed
    );
  }, [result.entityResults, filterMode]);

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <div
        className={cn(
          'rounded-lg border transition-colors',
          isActive ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
        )}
      >
        {/* Specification Header */}
        <CollapsibleTrigger asChild>
          <button
            className="w-full p-3 text-left"
            onClick={onSelect}
          >
            <div className="flex items-start gap-2">
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 mt-0.5 shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 mt-0.5 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <StatusIcon status={result.status} />
                  <span className="font-medium text-sm truncate">
                    {result.specification.name}
                  </span>
                </div>
                {result.specification.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                    {result.specification.description}
                  </p>
                )}
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Building2 className="h-3 w-3" />
                    {result.applicableCount} entities
                  </span>
                  <span className="text-green-600">{result.passedCount} passed</span>
                  <span className="text-red-600">{result.failedCount} failed</span>
                </div>
                <div className="mt-2">
                  <PassRateBar passRate={result.passRate} />
                </div>
              </div>
            </div>
          </button>
        </CollapsibleTrigger>

        {/* Entity Results */}
        <CollapsibleContent>
          <Separator />
          <div className="max-h-64 overflow-auto">
            {filteredEntities.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground text-center">
                No {filterMode === 'failed' ? 'failed' : filterMode === 'passed' ? 'passed' : ''} entities
              </div>
            ) : (
              <div className="divide-y">
                {filteredEntities.slice(0, 100).map((entity) => (
                  <EntityResultRow
                    key={`${entity.modelId}:${entity.expressId}`}
                    entity={entity}
                    onClick={() => onEntityClick(entity.modelId, entity.expressId)}
                  />
                ))}
                {filteredEntities.length > 100 && (
                  <div className="p-2 text-xs text-muted-foreground text-center">
                    Showing 100 of {filteredEntities.length} entities
                  </div>
                )}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ============================================================================
// Entity Result Row Component
// ============================================================================

interface EntityResultRowProps {
  entity: IDSEntityResult;
  onClick: () => void;
}

function EntityResultRow({ entity, onClick }: EntityResultRowProps) {
  const [showDetails, setShowDetails] = useState(false);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setShowDetails(true);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setShowDetails(false);
    }
  };

  return (
    <div className="hover:bg-muted/50 focus-within:bg-muted/50 focus-within:ring-2 focus-within:ring-primary focus-within:ring-inset rounded-md">
      <button
        className="w-full p-2 text-left flex items-center gap-2 focus:outline-none"
        onClick={onClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        aria-expanded={showDetails}
        aria-label={`${entity.entityName || '#' + entity.expressId} - ${entity.entityType} - ${entity.passed ? 'Passed' : 'Failed'}`}
      >
        <StatusIcon status={entity.passed ? 'pass' : 'fail'} />
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate">
            {entity.entityName || `#${entity.expressId}`}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {entity.entityType}
            {entity.globalId && ` · ${entity.globalId}`}
          </div>
        </div>
        {/* Chevron - shrink-0 keeps it visible */}
        <span
          role="button"
          tabIndex={-1}
          className="shrink-0 p-1 rounded hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation();
            setShowDetails(!showDetails);
          }}
          aria-label={showDetails ? 'Hide details' : 'Show details'}
        >
          {showDetails ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
      </button>
      {showDetails && (
        <div className="pl-8 pr-2 pb-2 space-y-1">
          {entity.requirementResults.map((req, idx) => (
            <RequirementResultRow key={req.requirement.id || idx} result={req} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Requirement Result Row Component
// ============================================================================

interface RequirementResultRowProps {
  result: IDSRequirementResult;
}

function RequirementResultRow({ result }: RequirementResultRowProps) {
  return (
    <div className="text-xs flex items-start gap-2 py-1">
      <StatusIcon status={result.status} />
      <div className="flex-1 min-w-0">
        <div className="text-muted-foreground">{result.checkedDescription}</div>
        {result.failureReason && (
          <div className="text-red-600 mt-0.5">{result.failureReason}</div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Report Export Split Button
// ============================================================================

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

function ReportExportButton({
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

// ============================================================================
// Main Panel Component
// ============================================================================

export function IDSPanel({ onClose }: IDSPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    // State
    document,
    auditReport,
    auditing,
    report,
    loading,
    progress,
    error,
    activeSpecificationId,
    filterMode,

    // Actions
    loadIDSFile,
    clearIDS,
    runValidation,
    clearValidation,
    setActiveSpecification,
    selectEntity,
    setFilterMode,
    applyColors,
    isolateFailed,
    isolatePassed,
    clearIsolation,
    exportReportJSON,
    exportReportHTML,
    exportReportBCF,
    bcfExportProgress,
  } = useIDS();

  // Handle file selection
  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await loadIDSFile(file);
    }
    // Reset input for re-selection of same file
    e.target.value = '';
  }, [loadIDSFile]);

  const loadIdsFromDialog = useCallback(async (): Promise<boolean> => {
    const file = await openGenericFileDialog({
      title: 'Open IDS File',
      filters: [
        { name: 'IDS Files', extensions: ['ids', 'xml'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (file) {
      await loadIDSFile(file);
      return true;
    }
    return false;
  }, [loadIDSFile]);

  const handleLoadIdsClick = useCallback(async () => {
    const loaded = await loadIdsFromDialog();
    if (loaded) {
      return;
    }
    fileInputRef.current?.click();
  }, [loadIdsFromDialog]);

  const handleDesktopRunValidation = useCallback(async () => {
    if (!document) {
      const loaded = await loadIdsFromDialog();
      if (!loaded) {
        return;
      }
    }
    await runValidation();
  }, [document, loadIdsFromDialog, runValidation]);

  useEffect(() => {
    const drainDesktopActions = () => {
      if (claimNextDesktopPanelAction('ids-open')) {
        void loadIdsFromDialog();
      }
      if (claimNextDesktopPanelAction('ids-run-validation')) {
        void handleDesktopRunValidation();
      }
    };

    drainDesktopActions();
    return subscribeDesktopPanelActions(drainDesktopActions);
  }, [handleDesktopRunValidation, loadIdsFromDialog]);

  // Handle entity click
  const handleEntityClick = useCallback((modelId: string, expressId: number) => {
    selectEntity(modelId, expressId);
  }, [selectEntity]);

  // Render validation progress
  const renderProgress = () => {
    if (!progress) return null;

    return (
      <div className="p-3 border-b">
        <div className="flex items-center gap-2 mb-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">
            {progress.phase === 'filtering' && 'Finding applicable entities...'}
            {progress.phase === 'validating' && `Validating... (${progress.entitiesProcessed}/${progress.totalEntities})`}
            {progress.phase === 'complete' && 'Complete'}
          </span>
        </div>
        <Progress value={progress.percentage} className="h-2" />
      </div>
    );
  };

  // Render empty state
  const renderEmptyState = () => {
    if (document) return null;

    // When parse failed but the auditor still produced issues, surface
    // them here. This is the most common path for malformed input —
    // bare "Invalid XML format" tells the user nothing actionable, but
    // the audit lists the specific structural problems.
    const hasAuditIssues =
      auditReport !== null && auditReport.issues.length > 0;

    return (
      <div className="flex flex-col h-full p-6">
        {hasAuditIssues && (
          <div className="mb-4">
            <IDSAuditSummary report={auditReport} auditing={auditing} />
          </div>
        )}

        <div className="flex flex-col items-center justify-center flex-1 text-center">
          <FileText className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="font-medium text-sm mb-2">
            {hasAuditIssues ? 'IDS Document Has Errors' : 'No IDS Loaded'}
          </h3>
          <p className="text-xs text-muted-foreground mb-4">
            {hasAuditIssues
              ? 'Fix the issues above and try loading again.'
              : 'Load an IDS (Information Delivery Specification) file to validate your model'}
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".ids,.xml"
            className="hidden"
            onChange={handleFileSelect}
          />
          <Button onClick={() => { void handleLoadIdsClick(); }}>
            <Upload className="h-4 w-4 mr-2" />
            {hasAuditIssues ? 'Load Different File' : 'Load IDS File'}
          </Button>
        </div>
      </div>
    );
  };

  // Render document loaded but no validation
  const renderDocumentLoaded = () => {
    if (!document || report) return null;

    // Only the document-level auditor's `error` verdict gates model
    // validation — warnings still let the user proceed (they're style
    // hints, not blockers). The button keeps its primary affordance
    // unless we genuinely can't validate.
    const auditHasErrors = auditReport?.status === 'error';

    return (
      <div className="p-4 space-y-3">
        <div className="rounded-lg border p-4">
          <h3 className="font-medium text-sm mb-1">{document.info.title}</h3>
          {document.info.description && (
            <p className="text-xs text-muted-foreground mb-2">{document.info.description}</p>
          )}
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span>{document.specifications.length} specifications</span>
            {document.info.version && <span>v{document.info.version}</span>}
          </div>
        </div>

        <IDSAuditSummary report={auditReport} auditing={auditing} />

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block">
              <Button
                className="w-full"
                onClick={runValidation}
                disabled={loading || auditHasErrors}
                variant={auditHasErrors ? 'secondary' : 'default'}
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                Run Validation
              </Button>
            </span>
          </TooltipTrigger>
          {auditHasErrors && (
            <TooltipContent>
              Resolve audit errors before validating against a model.
            </TooltipContent>
          )}
        </Tooltip>
      </div>
    );
  };

  // Render validation results
  const renderResults = () => {
    if (!report) return null;

    return (
      <>
        {/* Audit summary stays visible above the validation report so
            users can still see authoring issues alongside model results. */}
        {auditReport && auditReport.status !== 'valid' && (
          <div className="p-3 border-b">
            <IDSAuditSummary report={auditReport} auditing={false} />
          </div>
        )}

        {/* Summary Header */}
        <div className="p-3 border-b bg-muted/30">
          <div className="flex items-center gap-2 mb-2">
            <StatusIcon status={report.summary.failedSpecifications > 0 ? 'fail' : 'pass'} />
            <span className="font-medium text-sm">
              {report.summary.passedSpecifications}/{report.summary.totalSpecifications} Specifications Passed
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs text-center">
            <div className="bg-background rounded p-2">
              <div className="font-medium">{report.summary.totalEntitiesChecked}</div>
              <div className="text-muted-foreground">Checked</div>
            </div>
            <div className="bg-background rounded p-2">
              <div className="font-medium text-green-600">{report.summary.totalEntitiesPassed}</div>
              <div className="text-muted-foreground">Passed</div>
            </div>
            <div className="bg-background rounded p-2">
              <div className="font-medium text-red-600">{report.summary.totalEntitiesFailed}</div>
              <div className="text-muted-foreground">Failed</div>
            </div>
          </div>
          <div className="mt-2">
            <PassRateBar passRate={report.summary.overallPassRate} />
          </div>
          <p className="text-xs text-muted-foreground mt-2 text-center">
            💡 Click any entity to select and zoom to it in the 3D view
          </p>
        </div>

        {/* Filter & Actions Bar */}
        <div className="p-2 border-b flex items-center gap-1 flex-wrap">
          <Select value={filterMode} onValueChange={(v) => setFilterMode(v as 'all' | 'failed' | 'passed')}>
            <SelectTrigger className="h-8 w-24">
              <Filter className="h-3 w-3 mr-1" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="passed">Passed</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex-1 min-w-2" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={isolateFailed}>
                <EyeOff className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Isolate Failed</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={isolatePassed}>
                <Eye className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Isolate Passed</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={clearIsolation}>
                <Focus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear Isolation</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={applyColors}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reapply Colors</TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-4 mx-1" />

          <ReportExportButton
            onExportJSON={exportReportJSON}
            onExportHTML={exportReportHTML}
            onExportBCF={exportReportBCF}
            bcfExportProgress={bcfExportProgress}
            report={report}
          />
        </div>

        {/* Specifications List */}
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-2">
            {report.specificationResults.map((specResult) => (
              <SpecificationCard
                key={specResult.specification.id}
                result={specResult}
                isActive={activeSpecificationId === specResult.specification.id}
                onSelect={() => setActiveSpecification(specResult.specification.id)}
                onEntityClick={handleEntityClick}
                filterMode={filterMode}
              />
            ))}
          </div>
        </ScrollArea>
      </>
    );
  };

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4" />
          <span className="font-medium text-sm">IDS Validation</span>
        </div>
        <div className="flex items-center gap-1">
          {/* Load New IDS */}
          {document && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".ids,.xml"
                className="hidden"
                onChange={handleFileSelect}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => { void handleLoadIdsClick(); }}
                  >
                    <Upload className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Load New IDS</TooltipContent>
              </Tooltip>
            </>
          )}

          {/* Clear */}
          {document && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => {
                    clearIDS();
                    clearValidation();
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Clear IDS</TooltipContent>
            </Tooltip>
          )}

          {/* Close */}
          {onClose && (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800">
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* Progress */}
      {loading && renderProgress()}

      {/* Content */}
      <div className="flex-1 min-h-0 flex flex-col">
        {renderEmptyState()}
        {renderDocumentLoaded()}
        {renderResults()}
      </div>
    </div>
  );
}
