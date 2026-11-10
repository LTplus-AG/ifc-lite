/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { validateWidget, type DockContribution, type SlotContribution } from '@ifc-lite/extensions';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import type { WidgetRendererContext } from './widget/WidgetRenderer';
import { WidgetErrorBoundary } from './widget/WidgetErrorBoundary';
import { toast } from '@/components/ui/toast';
import { describeRunCommandError } from '@/services/extensions/runtime-errors';
import { useTranslation } from '@/i18n';

// Empty dock slots must not load the widget DSL. Keep the command lifetime and
// error boundary outside the deferred renderer so retirement remains immediate.
const WidgetRenderer = lazy(() => import('./widget/WidgetRenderer').then(module => ({ default: module.WidgetRenderer })));

export function ExtensionDockBody({ contribution, beforeCommand }: { contribution: SlotContribution<DockContribution>; beforeCommand?: () => boolean }) {
  const { t } = useTranslation();
  const host = useExtensionHost();
  // A committed lifetime prevents pending commands surviving provider, slot or
  // mount replacement, including a switch away and back to the same identities.
  const lifetime = useRef<{ host: typeof host; contribution: typeof contribution } | null>(null);
  useLayoutEffect(() => {
    const current = { host, contribution };
    lifetime.current = current;
    return () => { if (lifetime.current === current) lifetime.current = null; };
  }, [host, contribution]);
  const [widget, setWidget] = useState<unknown>();
  const [error, setError] = useState<string | undefined>();
  // A dock widget's buttons may invoke only its OWN extension's commands.
  //
  // This is a deliberate behaviour restriction. Before it, `invokeCommand`
  // took a bare id and ran the first enabled extension declaring it, so a
  // widget could reach any installed extension's command by naming the
  // string. That is exactly the ambient authority
  // `docs/architecture/ai-customization/02-security.md` §3.3 rules out:
  // "if an extension can acquire authority by naming a string, capability
  // grants become a polite suggestion".
  //
  // Cross-extension invocation is not being removed from the design, it is
  // being put behind the grant that already describes it. The catalogue
  // (`packages/extensions/src/capability/catalogue.ts`) defines
  // `command.invoke:<id-pattern>`, "Invoke other extensions' commands
  // matching the listed id pattern". Nothing in this tree enforces it:
  // `packages/extensions/src/host/permissions.ts` records it as "handled by
  // host dispatcher; no sandbox flag" and the dispatcher has no such check,
  // no code reads a `command`-scope capability, and no manifest in the repo
  // (fixtures, canaries, examples, docs samples) requests one. The roadmap
  // still lists inter-extension communication as an open question
  // (`07-roadmap.md` §5, item 2). Denying by default until the grant is enforced
  // is the reading that matches the spec; widening it later is a capability
  // check at this call site, not a redesign.
  const ctx: WidgetRendererContext = useMemo(
    () => ({
      state: {},
      invokeCommand: (commandId: string, args?: Record<string, unknown>) => {
        if (beforeCommand && !beforeCommand()) return;
        const current = lifetime.current;
        const isCurrent = () => current !== null && lifetime.current === current
          && current.host === host && current.contribution === contribution
          && host.slotRegistry.getAll(contribution.slot).includes(contribution);
        if (!isCurrent()) {
          toast.error(t('commandPalette.availability.feature'));
          return;
        }
        host.runCommand(commandId, contribution.extensionId, args, isCurrent).catch((err) => {
          console.warn('[ExtensionDockHost] command failed:', err);
          toast.error(describeRunCommandError(commandId, err));
        });
      },
    }),
    [host, contribution, t, beforeCommand],
  );

  useEffect(() => {
    let cancelled = false;
    setWidget(undefined);
    setError(undefined);
    void (async () => {
      try {
        const bundle = host.loader.getBundle(contribution.extensionId);
        if (!bundle) {
          if (!cancelled) setError(`Bundle for ${contribution.extensionId} not loaded.`);
          return;
        }
        const file = bundle.files.get(contribution.payload.widget);
        if (!file) {
          if (!cancelled) setError(`Widget "${contribution.payload.widget}" not found in bundle.`);
          return;
        }
        const text = file.text ?? new TextDecoder().decode(file.bytes);
        const json = JSON.parse(text);
        // Validate the shape before handing it to the renderer so we
        // surface a clean structured error instead of a deep crash.
        const validated = validateWidget(json, contribution.payload.widget);
        if (!validated.ok) {
          const first = validated.errors[0];
          if (!cancelled) setError(`Widget ${first?.path || ''} ${first?.message ?? 'failed validation'}`);
          return;
        }
        if (!cancelled) setWidget(validated.value);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, contribution]);

  if (error) {
    return (
      <div role="alert" className="p-3 text-xs text-danger">
        {error}
      </div>
    );
  }
  if (!widget) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        {t('extensionsFlavors.extensionDockHost.loadingWidget')}
      </div>
    );
  }
  return (
    <div className="p-3">
      <WidgetErrorBoundary
        // Keyed on the same identity shown in the fallback label: the
        // boundary never clears `state.error` itself (see its doc
        // comment), so a `key` change is what forces React to discard
        // a crashed instance and mount a fresh one for a new widget.
        key={`${contribution.extensionId}/${contribution.payload.widget}`}
        label={`${contribution.extensionId}/${contribution.payload.widget}`}
      >
        <Suspense fallback={<div className="text-xs text-muted-foreground">{t('extensionsFlavors.extensionDockHost.loadingWidget')}</div>}>
          <WidgetRenderer
            node={widget as Parameters<typeof WidgetRenderer>[0]['node']}
            ctx={ctx}
          />
        </Suspense>
      </WidgetErrorBoundary>
    </div>
  );
}
