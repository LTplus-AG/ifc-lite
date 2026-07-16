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

import React, { useCallback, useState, useMemo, useRef, useEffect } from 'react';
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
  Boxes,
  Layers,
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
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { useViewerStore } from '@/store';
import { IDSAuditSummary } from './IDSAuditSummary';
import { IDSExportDialog } from './IDSExportDialog';
import type { IDSBCFExportSettings, IDSExportProgress } from './IDSExportDialog';

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
    isolationScope,
    isolateMode,
    isolationActive,

    // Actions
    loadIDSFile,
    clearIDS,
    runValidation,
    clearValidation,
    setActiveSpecification,
    selectEntity,
    setFilterMode,
    setIsolationScope,
    applyColors,
    isolateFailed,
    isolatePassed,
    isolateInvolved,
    clearIsolation,
    exportReportJSON,
    exportReportHTML,
    exportReportBCF,
    bcfExportProgress,
  } = useIDS();

  // Validation runs against one model at a time. When a federation is loaded,
  // surface which model the results reflect and let the user switch (#1591).
  const idsMultiModel = useViewerStore((s) => s.models.size > 1);
  // Full model list for the target-model picker (federation): lets the user
  // see which model the results reflect and switch to validate another one.
  const idsModels = useViewerStore((s) => s.models);
  // Only offer models that actually carry parsed IFC data. Geometry-only,
  // mid-load or cache-restored models have no `ifcDataStore` and cannot be
  // validated — listing them would let the user pick a model whose report
  // would silently reflect a different model's data (#1702 C1).
  const idsModelList = useMemo(
    () => Array.from(idsModels.values()).filter((m) => m.ifcDataStore != null),
    [idsModels],
  );

  // The controlled picker binds to the landed report's model id, which only
  // updates once a run completes. Hold the user's in-flight choice locally so
  // the dropdown keeps showing the model being validated instead of snapping
  // back to the previous one while `loading` (#1702 C3).
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
  useEffect(() => {
    // Once a run settles (report landed or errored), fall back to the report's
    // own model id so the picker reflects reality again.
    if (!loading) setPendingModelId(null);
  }, [loading]);

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

  // Handle entity click
  const handleEntityClick = useCallback((modelId: string, expressId: number) => {
    selectEntity(modelId, expressId);
  }, [selectEntity]);

  // Active state for the isolate toggle buttons. A button is "active" only
  // when ITS mode is applied AND isolation is still live, so an externally
  // cleared isolation self-heals the button back to inactive.
  const failedActive = isolationActive && isolateMode === 'failed';
  const passedActive = isolationActive && isolateMode === 'passed';
  const involvedActive = isolationActive && isolateMode === 'involved';

  // Clicking the active isolate button toggles it off (undo).
  const handleIsolateFailed = useCallback(() => {
    if (failedActive) clearIsolation();
    else isolateFailed();
  }, [failedActive, clearIsolation, isolateFailed]);

  const handleIsolatePassed = useCallback(() => {
    if (passedActive) clearIsolation();
    else isolatePassed();
  }, [passedActive, clearIsolation, isolatePassed]);

  const handleIsolateInvolved = useCallback(() => {
    if (involvedActive) clearIsolation();
    else isolateInvolved();
  }, [involvedActive, clearIsolation, isolateInvolved]);

  // Render validation progress
  const renderProgress = () => {
    if (!progress) return null;

    // Validation of large code-list IDS packs runs for many seconds, and
    // a few broad specs dominate the time — so a percentage keyed on spec
    // index sits near 0 for a while. Surface the always-advancing spec
    // counter (and the per-spec entity count) so the panel visibly moves
    // throughout, not just in the back half.
    const specNumber = Math.min(progress.specificationIndex + 1, progress.totalSpecifications);
    const isComplete = progress.phase === 'complete';
    const headline = isComplete
      ? 'Validation complete'
      : `Validating specification ${specNumber} of ${progress.totalSpecifications}`;
    const detail =
      progress.phase === 'validating' && progress.totalEntities > 0
        ? `Checking ${progress.entitiesProcessed.toLocaleString()} / ${progress.totalEntities.toLocaleString()} entities`
        : progress.phase === 'filtering' && progress.totalEntities > 0
          ? `Scanning ${progress.entitiesProcessed.toLocaleString()} / ${progress.totalEntities.toLocaleString()} candidates`
          : progress.phase === 'filtering'
            ? 'Finding applicable entities…'
            : null;

    return (
      <div className="p-3 border-b">
        <div className="flex items-center gap-2 mb-1">
          {!isComplete && <Loader2 className="h-4 w-4 animate-spin shrink-0" />}
          <span className="text-sm font-medium tabular-nums">{headline}</span>
        </div>
        {detail && <div className="text-xs text-muted-foreground mb-2 tabular-nums">{detail}</div>}
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
          <Button onClick={() => { void handleLoadIdsClick(); }} {...tourAnchor(TOUR_ANCHORS.idsLoad)}>
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
                onClick={() => { void runValidation(); }}
                disabled={loading || auditHasErrors}
                variant={auditHasErrors ? 'secondary' : 'default'}
                {...tourAnchor(TOUR_ANCHORS.idsRun)}
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

    // In 'spec' scope the isolate/color actions target the active
    // specification; disable them until one is selected.
    const specScope = isolationScope === 'spec';
    const noActiveSpec = specScope && !activeSpecificationId;
    const scopeSuffix = specScope ? ' (this spec)' : ' (whole IDS)';

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
        <div className="p-3 border-b bg-muted/30" {...tourAnchor(TOUR_ANCHORS.idsSummary)}>
          {idsMultiModel && (
            <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground min-w-0">
              <span className="shrink-0">Validate</span>
              {/* Federation targets one model at a time. Surface it as a picker
                  (same plain-select pattern as Compare) so the user can both
                  see which model the results reflect and switch to another.
                  Changing it re-runs validation against the chosen model. */}
              <select
                value={pendingModelId ?? report.modelInfo.modelId}
                onChange={(e) => {
                  // An active isolation (failed/passed/involved) pins
                  // isolatedEntities to the OLD model's global ids. The new
                  // report replaces idsIsolateMode but leaves those ids in
                  // place, so the new target would look hidden. Clear the
                  // isolation before validating the newly picked model.
                  clearIsolation();
                  setPendingModelId(e.target.value);
                  void runValidation(e.target.value);
                }}
                disabled={loading}
                aria-label="Model to validate"
                className="min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs text-foreground disabled:opacity-50"
              >
                {idsModelList.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          )}
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
            {specScope
              ? '💡 Select a specification to isolate its elements — passed green, failed red'
              : '💡 Click any entity to select and zoom to it in the 3D view'}
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

          {/* Isolate scope: whole report vs. the active specification (#1236).
              'Per Spec' isolates the selected specification's elements
              (passed green, failed red). */}
          <Select value={isolationScope} onValueChange={(v) => setIsolationScope(v as 'ids' | 'spec')}>
            <SelectTrigger className="h-8 w-[112px]" aria-label="Isolate scope">
              <Layers className="h-3 w-3 mr-1" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ids">Whole IDS</SelectItem>
              <SelectItem value="spec">Per Spec</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex-1 min-w-2" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={failedActive ? 'secondary' : 'ghost'}
                size="sm"
                className={cn('h-8 w-8 p-0', failedActive && 'text-red-600')}
                aria-pressed={failedActive}
                aria-label={failedActive ? 'Show all (undo isolate failed)' : `Isolate failed${scopeSuffix}`}
                onClick={handleIsolateFailed}
                disabled={noActiveSpec}
                {...tourAnchor(TOUR_ANCHORS.idsIsolateFailed)}
              >
                <EyeOff className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {failedActive ? 'Show all (undo isolate failed)' : `Isolate failed${scopeSuffix}`}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={passedActive ? 'secondary' : 'ghost'}
                size="sm"
                className={cn('h-8 w-8 p-0', passedActive && 'text-green-600')}
                aria-pressed={passedActive}
                aria-label={passedActive ? 'Show all (undo isolate passed)' : `Isolate passed${scopeSuffix}`}
                onClick={handleIsolatePassed}
                disabled={noActiveSpec}
              >
                <Eye className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {passedActive ? 'Show all (undo isolate passed)' : `Isolate passed${scopeSuffix}`}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={involvedActive ? 'secondary' : 'ghost'}
                size="sm"
                className="h-8 w-8 p-0"
                aria-pressed={involvedActive}
                aria-label={involvedActive ? 'Show all (undo isolate involved)' : `Isolate involved${scopeSuffix}`}
                onClick={handleIsolateInvolved}
                disabled={noActiveSpec}
              >
                <Boxes className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {involvedActive
                ? 'Show all (undo isolate involved)'
                : `Isolate involved${scopeSuffix} — passed green + failed red`}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                aria-label="Clear isolation (show all)"
                onClick={clearIsolation}
                disabled={!isolationActive}
              >
                <Focus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear isolation (show all)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label="Reapply Colors" onClick={applyColors}>
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
        <ScrollArea className="flex-1" {...tourAnchor(TOUR_ANCHORS.idsResults)}>
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
                    aria-label="Load New IDS"
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
                  aria-label="Clear IDS"
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
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="Close" onClick={onClose}>
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
