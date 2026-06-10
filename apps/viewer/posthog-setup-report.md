<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into the IFC-Lite viewer. A `posthog-js` browser SDK singleton was created at `src/lib/analytics.ts` and initialized on app boot via a side-effect import in `src/main.tsx`. Ten business events spanning the core viewer workflows — model loading, IDS validation, clash detection, model comparison, AI chat, drawing export, and BYOK key management — were instrumented across six files with contextual properties. Error tracking via `captureException` was added to the IDS validation, clash detection, and model load failure paths.

**Important:** `posthog-js` was added to `package.json`. Run `pnpm install` from the workspace root (`/Users/louistrue/Development/ifc-lite`) to install it before building.

| Event | Description | File |
|---|---|---|
| `ifc_model_loaded` | IFC / IFC-X / GLB / point-cloud model successfully loaded | `src/hooks/useIfcLoader.ts` |
| `ifc_model_added` | Additional model added to federated viewer | `src/hooks/useIfcFederation.ts` |
| `ids_validation_completed` | IDS validation run finished with pass/fail summary | `src/hooks/useIDS.ts` |
| `ids_report_exported` | Validation report downloaded (JSON or HTML) | `src/hooks/ids/idsExportService.ts` |
| `clash_detection_run` | Clash detection completed with clash count | `src/hooks/useClash.ts` |
| `model_compare_run` | Model diff comparison completed | `src/hooks/useCompare.ts` |
| `ai_chat_message_sent` | User submitted a message to the AI assistant | `src/lib/llm/stream-client.ts` |
| `drawing_exported` | 2D floor-plan drawing exported as SVG | `src/hooks/useDrawingExport.ts` |
| `byok_key_saved` | User saved a BYOK API key (Anthropic or OpenAI) | `src/services/api-keys.ts` |
| `script_executed` | *(planned)* User ran a custom script | `src/components/viewer/ScriptPanel.tsx` |

## Next steps

We've built a dashboard and five insights for you to keep an eye on user behavior:

- [Analytics basics (wizard) — Dashboard](https://eu.posthog.com/project/199147/dashboard/739458)
- [IFC model loads over time](https://eu.posthog.com/project/199147/insights/qr0zg5Za)
- [IDS validation runs over time](https://eu.posthog.com/project/199147/insights/IGlyIgxi)
- [AI chat usage](https://eu.posthog.com/project/199147/insights/GuXiu44U)
- [Analysis feature usage (IDS / Clash / Compare / Drawing)](https://eu.posthog.com/project/199147/insights/yNXmOTaL)
- [BYOK key adoption](https://eu.posthog.com/project/199147/insights/VZcRpnDu)

### Agent skill

We've left an agent skill folder in your project at `.claude/skills/integration-javascript_node/`. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
