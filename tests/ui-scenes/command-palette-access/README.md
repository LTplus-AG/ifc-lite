# Command-palette feature access (#8947)

Every user-facing viewer feature, tool and action is reachable from the command
palette, either as a palette action or as a named destination that opens the
real tool flow through the canonical registry action. This is a separate
hillclimb from the general palette UX (#8946, merged in #8950). The work landed
in #8950, #8969 and #8972.

## Contract

- **Coverage.** Ribbon, menus, panels, contextual actions, modelling, settings,
  exports, extensions, runtime and recovery commands. Opening a parent panel
  does not count as access to its child controls: child flows have their own
  mounted tests. Duplicate entry points (the Analyze ribbon's panel browser)
  and dormant surfaces with no production caller (`registerAnalysisExtensions`)
  are recorded rather than projected.
- **Search.** Task-language aliases live in the localized catalogues
  (`apps/viewer/src/i18n/catalogues/command-palette.en.ts` and the de/fr/it/ru
  locales).
- **Availability.** Rows that cannot run stay discoverable and say why
  (`palette-availability.ts`). A refused row records no usage and runs nothing,
  and the reason updates live when the model, selection, role or extension
  changes.
- **Boundary.** The contract ends at the real configuration, review and launch
  controls. It does not cover parameter sweeps of downstream tools, publishing
  to remote services, paid providers, OS-native choosers or permission dialogs,
  or arbitrary third-party extension behaviour.

## Where the evidence lives

| Concern | Tests |
| --- | --- |
| Search, aliases, grouping | `commandPaletteSearch*.test.ts`, `commandPaletteWorkflowPaths.test.ts`, `palette-report-discovery.test.ts`, `ThemeSwitch.palette-access.test.tsx` |
| Keyboard and focus | `CommandPalette.interaction.test.tsx`, `CommandPalette.inline-focus.test.tsx`, `tests/e2e/command-palette-ux.e2e.spec.ts` |
| Prerequisites and refusals | `CommandPalette.interaction.test.tsx`, `CommandPalette.load-recovery.test.tsx`, `CommandPalette.reset-filters-access.test.tsx` |
| Child flows (mounted, real panels) | `CommandPalette.*-access.test.tsx`, `CommandPalette.workflow-*.test.tsx`, `CommandPalette.model-tool-launches.test.tsx` |
| Loaded/unloaded, selected/unselected, read-only, mobile, real IFC | `tests/e2e/command-palette-access.e2e.spec.ts` |
| Installed extension (QuickJS dock, disable, uninstall) | `tests/e2e/command-palette-access-extension.e2e.spec.ts` |

The source census used to build the coverage matrix (813 control identities and
3,994 callback anchors) is historical and is not kept in the tree. It is at
[`e530cfed`](https://github.com/LTplus-AG/ifc-lite/tree/e530cfed5e52fd83229262abda9e414371f1128f/tests/ui-scenes/command-palette-access/inventory).
The acceptance mapping is on #8947.

## Screenshot tooling

`capture-contexts.mjs` (six fixed unloaded/loaded/selected contexts) and
`capture-flows.mjs` (named destination flows) extend the shared real-IFC capture
protocol in `tests/ui-scenes/capture.mjs`. Pass `--dist`, `--out`, `--themes`
and, for a GPU-backed browser, `--cdp`. Captures are observations, not
assertions. `validate-candidate.sh` runs the root typecheck, the e2e build and
the four viewer shards from a clean checkout.
