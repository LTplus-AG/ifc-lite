/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * EPSG lookup dialog - search by code or name.
 *
 * Uses the local full EPSG index from @ifc-lite/data so search remains stable
 * and works offline once the bundle is loaded.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Search, Globe } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import {
  lookupEpsgByCode,
  searchEpsgIndex,
} from '@ifc-lite/data';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { EpsgLookupError } from './EpsgLookupError';

import { MAX_STARTER_RESULTS, COMMON_CRS, getStarterResults, toDialogResult, writeRecentCode, type EpsgResult } from './epsg-lookup-results';
export type { EpsgResult } from './epsg-lookup-results';

// ── Dialog component ───────────────────────────────────────────────────

interface EpsgLookupDialogProps {
  onSelect: (result: EpsgResult) => void;
  children?: React.ReactNode;
}
export function EpsgLookupDialog({ onSelect, children }: EpsgLookupDialogProps) {
  const focusSearch = useCallback((node: HTMLInputElement | null) => { node?.focus(); }, []);
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<EpsgResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const resetSearchState = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setQuery('');
    setResults([]);
    setLoading(false);
    setErrorKey(null);
  }, []);

  const localIndex = useMemo(
    () => COMMON_CRS.map(crs => ({ ...crs, _s: `${crs.code} ${crs.name} ${crs.area} ${crs.datum ?? ''} ${crs.projection ?? ''}`.toLowerCase() })),
    [],
  );

  const search = useCallback(async (searchQuery: string) => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      return;
    }

    const queryLower = trimmed.toLowerCase();
    const isCode = /^\d+$/.test(trimmed);
    const localMatches = localIndex
      .filter(c => isCode ? c.code.startsWith(trimmed) : c._s.includes(queryLower))
      .slice(0, 10);

    if (localMatches.length > 0) {
      setResults(localMatches);
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setErrorKey(null);

    try {
      const resolved = isCode
        ? await lookupEpsgByCode(trimmed, { prefix: true, limit: 25 })
        : await searchEpsgIndex(trimmed, { limit: 25 });
      if (controller.signal.aborted) return;

      const authoritativeMatches = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
      const dedupedResults: EpsgResult[] = [];
      const seenCodes = new Set<string>();
      for (const candidate of [
        ...localMatches.map(result => ({ code: result.code, result })),
        ...authoritativeMatches.map(entry => ({ code: entry.code, result: toDialogResult(entry) })),
      ]) {
        if (seenCodes.has(candidate.code)) continue;
        seenCodes.add(candidate.code);
        dedupedResults.push(candidate.result);
        if (dedupedResults.length >= 25) break;
      }

      if (dedupedResults.length > 0) {
        setResults(dedupedResults);
        setErrorKey(null);
      } else if (localMatches.length === 0) {
        setResults([]);
        setErrorKey('properties.epsgLookup.noResults');
      }
    } catch (err: unknown) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) return;
      console.error('[EPSG Lookup] Local search failed', err);
      if (localMatches.length === 0) {
        setErrorKey('properties.epsgLookup.searchUnavailable');
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [localIndex]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setErrorKey(null);
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(value), 250);
  }, [search]);

  const handleSelect = useCallback((result: EpsgResult) => {
    writeRecentCode(result.code);
    onSelect(result);
    setOpen(false);
    resetSearchState();
  }, [onSelect, resetSearchState]);

  useEffect(() => {
    if (!open || query.trim()) return;

    let cancelled = false;

    void getStarterResults()
      .then(starterResults => {
        if (cancelled) return;
        setResults(starterResults);
        setErrorKey(null);
      })
      .catch(() => {
        if (cancelled) return;
        setResults(COMMON_CRS.slice(0, MAX_STARTER_RESULTS));
        setErrorKey(null);
      });

    return () => {
      cancelled = true;
    };
  }, [open, query]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) resetSearchState();
      }}
    >
      <DialogTrigger asChild>
        {children || (
          <Button type="button" variant="outline" size="segment" className="gap-1 px-1.5 font-mono text-xs [&_svg]:size-2.5">
            <Search />
            {t('properties.epsgLookup.triggerButton')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-sm gap-0 p-0 overflow-hidden" hideCloseButton>
        <DialogHeader className="px-4 pt-4 pb-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Globe className="h-4 w-4 text-muted-foreground" />
            {t('properties.epsgLookup.title')}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {t('properties.epsgLookup.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 pb-3">
          <Input
            ref={focusSearch}
            placeholder={t('properties.epsgLookup.searchPlaceholder')} aria-label={t('properties.epsgLookup.searchInputLabel')}
            value={query}
            onChange={handleInputChange}
            leftIcon={loading ? <Spinner size="sm" /> : <Search className="h-3.5 w-3.5" />}
            className="h-8 text-xs"
          />
        </div>

        <EpsgLookupError errorKey={errorKey} />

        {results.length > 0 && (
          <div className="border-t overflow-y-auto max-h-[280px]">
            {results.map((result) => (
              <button
                key={result.code}
                className="w-full text-left px-4 py-2 hover:bg-muted/50 transition-colors border-b border-border/50 last:border-b-0"
                onClick={() => handleSelect(result)}
              >
                <div className="flex items-baseline gap-2 min-w-0">
                  <code className="text-xs font-bold text-foreground shrink-0">{result.code}</code>
                  <span className="text-xs text-foreground truncate">{result.name}</span>
                  {result.kind && (
                    <span className="text-xs text-muted-foreground shrink-0 ml-auto">{result.kind}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                  {result.area && <span className="truncate">{result.area}</span>}
                  {result.datum && <span className="shrink-0">{result.datum}</span>}
                  {result.unit && <span className="shrink-0">{result.unit}</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
