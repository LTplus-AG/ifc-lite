/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An analysis panel with nothing to show yet (#5834): the #5612 `EmptyState`
 * primitive plus "Try with demo data".
 *
 * The demo IDS and revision B (`lib/tours/demo-kit.ts`) used to be reachable
 * only from a tour. Loading them REPLACES the model set, so the offer is made
 * only while that replaces nothing of the user's: no model loaded, or only
 * demo-kit models loaded (`demoKitReplacesNothing`). With the user's own model
 * open the empty state keeps its own action alone.
 */

import { useState, type ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { demoKitReplacesNothing } from '@/lib/tours/demo-kit';
import { useTranslation } from '@/i18n';

interface AnalysisEmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  /** A second, smaller line (what to do once results exist). */
  hint?: string;
  /** The panel's own way forward (load a file, run). */
  action?: ReactNode;
  /** Loads the demo kit this panel can analyse; absent when there is none (BCF). */
  loadDemo?: () => Promise<void>;
  className?: string;
}

export function AnalysisEmptyState({ icon, title, description, hint, action, loadDemo, className }: AnalysisEmptyStateProps) {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const [loading, setLoading] = useState(false);
  const offerDemo = loadDemo !== undefined && demoKitReplacesNothing(models.values());

  const tryDemo = async (): Promise<void> => {
    if (!loadDemo) return;
    setLoading(true);
    try {
      await loadDemo();
    } catch (err) {
      console.error('[analysis] demo data failed to load', err);
      toast.error(t('analysisPanel.demo.failed'));
    } finally {
      setLoading(false);
    }
  };

  const footer = action || offerDemo || hint ? (
    <div className="flex flex-col items-center gap-2">
      {action}
      {offerDemo && (
        <Button variant="outline" size="sm" className="gap-1.5" disabled={loading} onClick={() => { void tryDemo(); }}>
          {loading ? <Spinner size="sm" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
          {t(loading ? 'analysisPanel.demo.loading' : 'analysisPanel.demo.try')}
        </Button>
      )}
      {hint && <p className="max-w-[240px] text-2xs text-muted-foreground">{hint}</p>}
    </div>
  ) : undefined;

  return <EmptyState icon={icon} title={title} description={description} action={footer} className={className} />;
}
