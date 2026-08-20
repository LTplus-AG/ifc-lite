/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Data Connector UI - Import data from CSV files and map to IFC properties
 *
 * Full integration with CsvConnector from @ifc-lite/mutations
 */

import { useState, useCallback, useMemo, useRef, useEffect, type DragEvent } from 'react';
import {
  Upload,
  FileSpreadsheet,
  Link2,
  ArrowRight,
  Check,
  AlertCircle,
  Loader2,
  Trash2,
  Plus,
  Eye,
  Play,
  Wand2,
  ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { configureMutationView } from '@/utils/configureMutationView';
import { PropertyValueType } from '@ifc-lite/data';
import {
  CsvConnector,
  MutablePropertyView,
  type CsvRow,
  type MatchStrategy,
  type PropertyMapping,
  type DataMapping,
  type MatchResult,
  type ImportStats,
  type ImportProgress,
} from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';

type MatchType = 'globalId' | 'expressId' | 'name' | 'property';

interface DataConnectorProps {
  trigger?: React.ReactNode;
}

interface CsvColumn {
  name: string;
  sampleValues: string[];
}

interface MappingRow {
  id: string;
  sourceColumn: string;
  targetPset: string;
  targetProperty: string;
  valueType: PropertyValueType;
}

export function DataConnector({ trigger }: DataConnectorProps) {
  const { models } = useIfc();
  const getMutationView = useViewerStore((s) => s.getMutationView);
  const registerMutationView = useViewerStore((s) => s.registerMutationView);
  // Collab role gate: CSV import writes straight to the mutation view (via
  // csvConnector.importAsync), bypassing the store's own setProperty action
  // (and its canCollabEdit() check) entirely — same gap as BulkPropertyEditor,
  // and the same fix: gate this component itself the way MainToolbar/AuthorTab
  // gate Edit mode. null role = single-user, always editable.
  const collabEditRole = useViewerStore((s) => s.collabRole);
  const canEditInSession =
    collabEditRole === null || collabEditRole === 'editor' || collabEditRole === 'admin';
  // Also get legacy single-model state for backward compatibility
  const legacyIfcDataStore = useViewerStore((s) => s.ifcDataStore);
  const legacyGeometryResult = useViewerStore((s) => s.geometryResult);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>('');

  // Raw CSV content
  const [csvContent, setCsvContent] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');

  // Parsed CSV data for preview
  const [parsedRows, setParsedRows] = useState<CsvRow[]>([]);
  const [csvColumns, setCsvColumns] = useState<CsvColumn[]>([]);

  // Matching configuration
  const [matchType, setMatchType] = useState<MatchType>('globalId');
  const [matchColumn, setMatchColumn] = useState<string>('');
  const [matchPset, setMatchPset] = useState<string>('');
  const [matchProp, setMatchProp] = useState<string>('');

  // Property mappings
  const [mappings, setMappings] = useState<MappingRow[]>([]);

  // Results
  const [matchResults, setMatchResults] = useState<MatchResult[] | null>(null);
  const [importStats, setImportStats] = useState<ImportStats | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Track whether config changed since last import (disables button after success)
  const [importDirty, setImportDirty] = useState(true);

  // Get list of models - includes both federated models and legacy single-model
  const modelList = useMemo(() => {
    const list = Array.from(models.values()).map((m) => ({
      id: m.id,
      name: m.name,
    }));

    // If no models in Map but legacy data exists, add a synthetic entry
    if (list.length === 0 && legacyIfcDataStore) {
      list.push({
        id: '__legacy__',
        name: 'Current Model',
      });
    }

    return list;
  }, [models, legacyIfcDataStore]);

  // Get selected model's data - supports both federated and legacy mode
  const selectedModel = useMemo(() => {
    if (selectedModelId === '__legacy__' && legacyIfcDataStore && legacyGeometryResult) {
      // Return a synthetic FederatedModel-like object for legacy mode
      return {
        id: '__legacy__',
        name: 'Current Model',
        ifcDataStore: legacyIfcDataStore,
        geometryResult: legacyGeometryResult,
        visible: true,
        collapsed: false,
      };
    }
    return models.get(selectedModelId);
  }, [models, selectedModelId, legacyIfcDataStore, legacyGeometryResult]);

  // Auto-select first model
  useMemo(() => {
    if (modelList.length > 0 && !selectedModelId) {
      setSelectedModelId(modelList[0].id);
    }
  }, [modelList, selectedModelId]);

  // Ensure mutation view exists for selected model
  useEffect(() => {
    if (!selectedModel?.ifcDataStore || !selectedModelId) return;

    // Check if mutation view already exists
    let mutationView = getMutationView(selectedModelId);
    if (mutationView) return;

    // Create new mutation view with on-demand property extractor
    const dataStore = selectedModel.ifcDataStore;
    mutationView = new MutablePropertyView(dataStore.properties || null, selectedModelId);

    configureMutationView(mutationView, dataStore as IfcDataStore);

    // Register the mutation view
    registerMutationView(selectedModelId, mutationView);
  }, [selectedModel, selectedModelId, getMutationView, registerMutationView]);

  // Create CsvConnector instance
  const csvConnector = useMemo(() => {
    if (!selectedModel?.ifcDataStore) return null;

    const mutationView = getMutationView(selectedModelId);
    if (!mutationView) return null;

    const dataStore = selectedModel.ifcDataStore;

    return new CsvConnector(
      dataStore.entities,
      mutationView,
      dataStore.strings || null
    );
  }, [selectedModel, selectedModelId, getMutationView]);

  // Parse CSV file
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setMatchResults(null);
    setImportStats(null);
    setError(null);
    setImportDirty(true);

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) return;

      setCsvContent(text);

      // Use CsvConnector to parse if available, otherwise do basic parsing for preview
      if (csvConnector) {
        try {
          const rows = csvConnector.parse(text);
          setParsedRows(rows);

          // Extract column names and sample values
          if (rows.length > 0) {
            const headers = Object.keys(rows[0]);
            const columns: CsvColumn[] = headers.map((name) => ({
              name,
              sampleValues: rows.slice(0, 3).map((row) => row[name] || ''),
            }));
            setCsvColumns(columns);

            // Auto-detect match column
            const globalIdCol = columns.find(
              (c) =>
                c.name.toLowerCase().includes('globalid') ||
                c.name.toLowerCase().includes('guid')
            );
            if (globalIdCol) {
              setMatchColumn(globalIdCol.name);
              setMatchType('globalId');
            }

            // Auto-detect property mappings
            const autoMappings = csvConnector.autoDetectMappings(headers);
            const mappingRows: MappingRow[] = autoMappings.map((m, idx) => ({
              id: `auto_${idx}_${Date.now()}`,
              sourceColumn: m.sourceColumn,
              targetPset: m.targetPset,
              targetProperty: m.targetProperty,
              valueType: m.valueType,
            }));

            // Filter out ID columns from auto mappings
            const filteredMappings = mappingRows.filter(
              (m) =>
                !m.sourceColumn.toLowerCase().includes('globalid') &&
                !m.sourceColumn.toLowerCase().includes('expressid') &&
                !m.sourceColumn.toLowerCase().includes('guid') &&
                m.sourceColumn.toLowerCase() !== 'id'
            );

            if (filteredMappings.length > 0) {
              setMappings(filteredMappings);
            }
          }
        } catch (err) {
          setError(`Failed to parse CSV: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      } else {
        // Basic parsing for preview before model selected
        const lines = text.split('\n').filter((line) => line.trim());
        if (lines.length < 2) {
          setError('CSV must have at least a header row and one data row');
          return;
        }

        const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
        const columns: CsvColumn[] = headers.map((name, idx) => ({
          name,
          sampleValues: lines
            .slice(1, 4)
            .map((line) => {
              const values = line.split(',');
              return values[idx]?.trim().replace(/^"|"$/g, '') || '';
            }),
        }));
        setCsvColumns(columns);

        // Auto-detect match column
        const globalIdCol = columns.find(
          (c) =>
            c.name.toLowerCase().includes('globalid') ||
            c.name.toLowerCase().includes('guid')
        );
        if (globalIdCol) {
          setMatchColumn(globalIdCol.name);
          setMatchType('globalId');
        }
      }
    };

    reader.readAsText(file);
    e.target.value = ''; // Reset input
  }, [csvConnector]);

  // Re-parse when model changes and we have content
  const handleModelChange = useCallback((modelId: string) => {
    setSelectedModelId(modelId);
    setMatchResults(null);
    setImportStats(null);
    setError(null);
    setImportDirty(true);
  }, []);

  // Add a mapping row
  const addMapping = useCallback(() => {
    setMappings((prev) => [
      ...prev,
      {
        id: `mapping_${Date.now()}`,
        sourceColumn: '',
        targetPset: 'Pset_Custom',
        targetProperty: '',
        valueType: PropertyValueType.String,
      },
    ]);
  }, []);

  // Remove a mapping
  const removeMapping = useCallback((id: string) => {
    setMappings((prev) => prev.filter((m) => m.id !== id));
  }, []);

  // Update a mapping
  const updateMapping = useCallback(
    (id: string, field: keyof MappingRow, value: string | number) => {
      setMappings((prev) =>
        prev.map((m) => (m.id === id ? { ...m, [field]: value } : m))
      );
    },
    []
  );

  // Auto-detect mappings
  const handleAutoDetect = useCallback(() => {
    if (!csvConnector || csvColumns.length === 0) return;

    const headers = csvColumns.map((c) => c.name);
    const autoMappings = csvConnector.autoDetectMappings(headers);

    const mappingRows: MappingRow[] = autoMappings
      .filter(
        (m) =>
          !m.sourceColumn.toLowerCase().includes('globalid') &&
          !m.sourceColumn.toLowerCase().includes('expressid') &&
          !m.sourceColumn.toLowerCase().includes('guid') &&
          m.sourceColumn.toLowerCase() !== 'id'
      )
      .map((m, idx) => ({
        id: `auto_${idx}_${Date.now()}`,
        sourceColumn: m.sourceColumn,
        targetPset: m.targetPset,
        targetProperty: m.targetProperty,
        valueType: m.valueType,
      }));

    setMappings(mappingRows);
  }, [csvConnector, csvColumns]);

  // Build DataMapping from UI state
  const buildDataMapping = useCallback((): DataMapping | null => {
    if (!matchColumn) return null;

    const matchStrategy: MatchStrategy =
      matchType === 'property'
        ? { type: 'property', psetName: matchPset, propName: matchProp, column: matchColumn }
        : { type: matchType, column: matchColumn };

    const propertyMappings: PropertyMapping[] = mappings
      .filter((m) => m.sourceColumn && m.targetProperty)
      .map((m) => ({
        sourceColumn: m.sourceColumn,
        targetPset: m.targetPset,
        targetProperty: m.targetProperty,
        valueType: m.valueType,
      }));

    return { matchStrategy, propertyMappings };
  }, [matchColumn, matchType, matchPset, matchProp, mappings]);

  // Preview matches using CsvConnector.preview
  const handlePreview = useCallback(() => {
    if (!csvConnector || !csvContent || !matchColumn) return;

    setIsProcessing(true);
    setMatchResults(null);
    setImportStats(null);
    setError(null);

    try {
      const dataMapping = buildDataMapping();
      if (!dataMapping) {
        setError('Invalid mapping configuration');
        setIsProcessing(false);
        return;
      }

      // Use CsvConnector preview method
      const preview = csvConnector.preview(csvContent, dataMapping);

      setParsedRows(preview.rows);
      setMatchResults(preview.matches);
    } catch (err) {
      console.error('Preview failed:', err);
      setError(`Preview failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsProcessing(false);
    }
  }, [csvConnector, csvContent, matchColumn, buildDataMapping]);

  // Import using CsvConnector.importAsync for non-blocking progress
  const handleImport = useCallback(async () => {
    if (!csvConnector || !csvContent || !canEditInSession) return;

    setIsProcessing(true);
    setImportStats(null);
    setImportProgress(null);
    setError(null);

    try {
      const dataMapping = buildDataMapping();
      if (!dataMapping) {
        setError('Invalid mapping configuration');
        setIsProcessing(false);
        return;
      }

      const stats = await csvConnector.importAsync(
        csvContent,
        dataMapping,
        (progress) => setImportProgress(progress)
      );

      setImportStats(stats);
      setImportProgress(null);
      setImportDirty(false);

      if (stats.errors.length > 0) {
        setError(stats.errors.join('\n'));
      }
    } catch (err) {
      console.error('Import failed:', err);
      setError(`Import failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsProcessing(false);
    }
  }, [csvConnector, csvContent, canEditInSession, buildDataMapping]);

  // Scroll to bottom of the body area — double rAF ensures DOM is painted
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollAreaRef.current?.scrollTo({
          top: scrollAreaRef.current.scrollHeight,
          behavior: 'smooth',
        });
      });
    });
  }, []);

  // Auto-scroll when import completes or errors appear
  useEffect(() => {
    if (importStats || error) scrollToBottom();
  }, [importStats, error, scrollToBottom]);

  // Auto-scroll when progress first appears (so user sees the bar)
  const prevProgressRef = useRef<ImportProgress | null>(null);
  useEffect(() => {
    if (importProgress && !prevProgressRef.current) scrollToBottom();
    prevProgressRef.current = importProgress;
  }, [importProgress, scrollToBottom]);

  // Mark config dirty when match/mapping settings change after a completed import
  useEffect(() => {
    if (importStats) setImportDirty(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only fire on config changes, not importStats itself
  }, [matchType, matchColumn, matchPset, matchProp, mappings]);

  // Stats from match results
  const matchStats = useMemo(() => {
    if (!matchResults) return null;
    const matched = matchResults.filter((r) => r.matchedEntityIds.length > 0).length;
    const unmatched = matchResults.filter((r) => r.matchedEntityIds.length === 0).length;
    const multiMatch = matchResults.filter((r) => r.matchedEntityIds.length > 1).length;
    const highConfidence = matchResults.filter((r) => r.confidence === 1).length;
    return { matched, unmatched, multiMatch, highConfidence, total: matchResults.length };
  }, [matchResults]);

  // Convert parsed rows to array for table display
  const previewData = useMemo(() => {
    if (parsedRows.length === 0) return [];
    return parsedRows.slice(0, 5).map((row) => {
      return csvColumns.map((col) => row[col.name] || '');
    });
  }, [parsedRows, csvColumns]);

  // Drag-and-drop handlers
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const file = e.dataTransfer.files[0];
      if (!file || !file.name.endsWith('.csv')) return;

      // Reuse the same file-reading logic via a synthetic event
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      if (fileInputRef.current) {
        fileInputRef.current.files = dataTransfer.files;
        fileInputRef.current.dispatchEvent(new Event('change', { bubbles: true }));
      }
    },
    []
  );

  // Derive the current step for the step indicator
  const currentStep = useMemo(() => {
    if (importStats) return 3;
    if (csvColumns.length > 0 && matchColumn && mappings.length > 0) return 2;
    if (csvColumns.length > 0) return 1;
    return 0;
  }, [csvColumns.length, matchColumn, mappings.length, importStats]);

  const steps = ['Upload CSV', 'Configure Mapping', 'Import'];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Upload className="h-4 w-4 mr-2" />
            Import Data
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col p-0 gap-0">
        {/* Fixed Header */}
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0 border-b">
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Import External Data
          </DialogTitle>
          <DialogDescription>
            Map CSV data to IFC entity properties
          </DialogDescription>

          {/* Step Indicator */}
          <div className="flex items-center gap-1 pt-3">
            {steps.map((step, idx) => (
              <div key={step} className="flex items-center gap-1">
                <div
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                    idx < currentStep
                      ? 'bg-primary/10 text-primary'
                      : idx === currentStep
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {idx < currentStep ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <span className="w-4 text-center">{idx + 1}</span>
                  )}
                  {step}
                </div>
                {idx < steps.length - 1 && (
                  <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                )}
              </div>
            ))}
          </div>
        </DialogHeader>

        {/* Scrollable Body */}
        <div ref={scrollAreaRef} className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-6">
            {/* Model selector */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Target Model</Label>
              <Select value={selectedModelId} onValueChange={handleModelChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {modelList.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedModelId && !csvConnector && (
                <p className="text-xs text-amber-600">
                  Note: MutationView not available for this model. Some features may be limited.
                </p>
              )}
            </div>

            {/* File Upload - Drag and Drop Zone */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">CSV File</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleFileSelect}
                className="hidden"
              />
              {!fileName ? (
                <div
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 cursor-pointer transition-colors ${
                    isDragging
                      ? 'border-primary bg-primary/5'
                      : 'border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/50'
                  }`}
                >
                  <Upload className={`h-8 w-8 ${isDragging ? 'text-primary' : 'text-muted-foreground'}`} />
                  <div className="text-center">
                    <p className="text-sm font-medium">
                      {isDragging ? 'Drop CSV file here' : 'Drag & drop a CSV file'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      or click to browse
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="gap-1.5">
                    <FileSpreadsheet className="h-3 w-3" />
                    {fileName}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Change
                  </Button>
                </div>
              )}
            </div>

            {csvColumns.length > 0 && (
              <>
                <Separator />

                {/* CSV Preview */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Data Preview</Label>
                  <ScrollArea className="h-32 border rounded-md">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {csvColumns.map((col) => (
                            <TableHead key={col.name} className="text-xs whitespace-nowrap">
                              {col.name}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {previewData.map((row, rowIdx) => (
                          <TableRow key={rowIdx}>
                            {row.map((cell, cellIdx) => (
                              <TableCell key={cellIdx} className="text-xs py-1">
                                {cell || '\u2014'}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                  <p className="text-xs text-muted-foreground">
                    {parsedRows.length > 0
                      ? `${parsedRows.length} rows parsed`
                      : `${csvColumns[0]?.sampleValues.length || 0} sample rows`}
                  </p>
                </div>

                <Separator />

                {/* Matching Configuration */}
                <div className="space-y-4">
                  <Label className="text-sm font-medium flex items-center gap-2">
                    <Link2 className="h-4 w-4" />
                    Entity Matching
                  </Label>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Match By</Label>
                      <Select value={matchType} onValueChange={(v) => setMatchType(v as MatchType)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="globalId">GlobalId</SelectItem>
                          <SelectItem value="expressId">EXPRESS ID</SelectItem>
                          <SelectItem value="name">Entity Name</SelectItem>
                          <SelectItem value="property">Property Value</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">CSV Column</Label>
                      <Select value={matchColumn} onValueChange={setMatchColumn}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select column" />
                        </SelectTrigger>
                        <SelectContent>
                          {csvColumns.map((col) => (
                            <SelectItem key={col.name} value={col.name}>
                              {col.name}
                              {col.sampleValues[0] && (
                                <span className="ml-2 text-muted-foreground">
                                  (e.g., {col.sampleValues[0].slice(0, 20)})
                                </span>
                              )}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {matchType === 'property' && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label className="text-xs text-muted-foreground">Property Set</Label>
                        <Input
                          value={matchPset}
                          onChange={(e) => setMatchPset(e.target.value)}
                          placeholder="e.g., Pset_WallCommon"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs text-muted-foreground">Property Name</Label>
                        <Input
                          value={matchProp}
                          onChange={(e) => setMatchProp(e.target.value)}
                          placeholder="e.g., Reference"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <Separator />

                {/* Property Mappings */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">Property Mappings</Label>
                    <div className="flex items-center gap-2">
                      {csvConnector && (
                        <Button variant="ghost" size="sm" onClick={handleAutoDetect}>
                          <Wand2 className="h-3 w-3 mr-1" />
                          Auto-detect
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={addMapping}>
                        <Plus className="h-3 w-3 mr-1" />
                        Add
                      </Button>
                    </div>
                  </div>

                  {mappings.length === 0 ? (
                    <div className="text-center py-6 border rounded-lg border-dashed">
                      <p className="text-sm text-muted-foreground">
                        No property mappings configured
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Click &quot;Auto-detect&quot; or &quot;Add&quot; to map CSV columns to IFC properties
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {/* Column headers for mapping rows */}
                      <div className="grid grid-cols-[1fr_auto_1fr_1fr_auto_auto] gap-2 px-2 text-xs text-muted-foreground">
                        <span>Source Column</span>
                        <span />
                        <span>Target Pset</span>
                        <span>Target Property</span>
                        <span>Type</span>
                        <span />
                      </div>
                      {mappings.map((mapping) => (
                        <div
                          key={mapping.id}
                          className="grid grid-cols-[1fr_auto_1fr_1fr_auto_auto] gap-2 items-center p-2 border rounded-md bg-muted/30"
                        >
                          <Select
                            value={mapping.sourceColumn}
                            onValueChange={(v) => updateMapping(mapping.id, 'sourceColumn', v)}
                          >
                            <SelectTrigger className="h-8">
                              <SelectValue placeholder="Column" />
                            </SelectTrigger>
                            <SelectContent>
                              {csvColumns.map((col) => (
                                <SelectItem key={col.name} value={col.name}>
                                  {col.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>

                          <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />

                          <Input
                            placeholder="Pset name"
                            value={mapping.targetPset}
                            onChange={(e) =>
                              updateMapping(mapping.id, 'targetPset', e.target.value)
                            }
                            className="h-8 text-xs"
                          />

                          <Input
                            placeholder="Property"
                            value={mapping.targetProperty}
                            onChange={(e) =>
                              updateMapping(mapping.id, 'targetProperty', e.target.value)
                            }
                            className="h-8 text-xs"
                          />

                          <Select
                            value={mapping.valueType.toString()}
                            onValueChange={(v) =>
                              updateMapping(mapping.id, 'valueType', parseInt(v))
                            }
                          >
                            <SelectTrigger className="h-8 w-24">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={PropertyValueType.String.toString()}>
                                String
                              </SelectItem>
                              <SelectItem value={PropertyValueType.Real.toString()}>
                                Real
                              </SelectItem>
                              <SelectItem value={PropertyValueType.Integer.toString()}>
                                Integer
                              </SelectItem>
                              <SelectItem value={PropertyValueType.Boolean.toString()}>
                                Boolean
                              </SelectItem>
                            </SelectContent>
                          </Select>

                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => removeMapping(mapping.id)}
                          >
                            <Trash2 className="h-3 w-3 text-destructive" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Match Results */}
                {matchStats && (
                  <Alert>
                    <Eye className="h-4 w-4" />
                    <AlertTitle>Match Results</AlertTitle>
                    <AlertDescription className="flex flex-wrap items-center gap-2">
                      <Badge variant="default">{matchStats.matched} matched</Badge>
                      <Badge variant="secondary">{matchStats.unmatched} unmatched</Badge>
                      <Badge variant="outline">
                        {matchStats.highConfidence} high confidence
                      </Badge>
                      {matchStats.multiMatch > 0 && (
                        <Badge variant="destructive">
                          {matchStats.multiMatch} multi-match
                        </Badge>
                      )}
                    </AlertDescription>
                  </Alert>
                )}

                {/* Live Import Progress */}
                {importProgress && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm text-muted-foreground">
                      <span className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {importProgress.phase === 'parsing' && 'Parsing CSV...'}
                        {importProgress.phase === 'matching' && 'Matching entities...'}
                        {importProgress.phase === 'applying' && 'Applying properties...'}
                      </span>
                      <span className="tabular-nums">
                        {importProgress.matchedRows.toLocaleString()} matched
                        {importProgress.mutationsCreated > 0 &&
                          ` \u00b7 ${importProgress.mutationsCreated.toLocaleString()} written`}
                      </span>
                    </div>
                    <Progress value={importProgress.percent * 100} />
                  </div>
                )}

                {/* Import Stats */}
                {importStats && (
                  <Alert
                    variant={importStats.errors.length === 0 ? 'default' : 'destructive'}
                  >
                    <Check className="h-4 w-4" />
                    <AlertTitle>Import Complete</AlertTitle>
                    <AlertDescription>
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <Badge variant="default">
                          {importStats.mutationsCreated} properties updated
                        </Badge>
                        <Badge variant="secondary">
                          {importStats.matchedRows} rows matched
                        </Badge>
                        <Badge variant="outline">
                          {importStats.unmatchedRows} rows unmatched
                        </Badge>
                      </div>
                      {importStats.warnings.length > 0 && (
                        <div className="mt-2 text-xs text-amber-600">
                          {importStats.warnings.length} warning(s)
                        </div>
                      )}
                    </AlertDescription>
                  </Alert>
                )}

                {/* Error Display */}
                {error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Error</AlertTitle>
                    <AlertDescription className="whitespace-pre-wrap">
                      {error}
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}
          </div>
        </div>

        {/* Fixed Footer */}
        <DialogFooter className="px-6 py-4 border-t shrink-0 gap-2">
          <Button
            variant="secondary"
            onClick={handlePreview}
            disabled={!csvConnector || !csvContent || !matchColumn || isProcessing}
          >
            {isProcessing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Eye className="h-4 w-4 mr-2" />
            )}
            Preview Matches
          </Button>
          <Button
            onClick={handleImport}
            disabled={
              !canEditInSession ||
              !csvConnector ||
              !csvContent ||
              !matchColumn ||
              mappings.length === 0 ||
              isProcessing ||
              !importDirty
            }
            title={canEditInSession ? undefined : 'Editing requires editor access in this shared session'}
          >
            {isProcessing && importProgress ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {Math.round(importProgress.percent * 100)}%
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                {matchStats ? `Import ${matchStats.matched} rows` : 'Import'}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
