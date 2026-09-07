---
"@ifc-lite/viewer": patch
"@ifc-lite/bcf": patch
"@ifc-lite/bcf-api": patch
"@ifc-lite/sdk": patch
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
"@ifc-lite/sandbox": patch
---

Finish renaming the BCF "issues" language to "topics" across the app, docs, and package-facing text. Per the BCF-XML specification, `Topic` is the container element and `Issue` is only one `TopicType` value among several (Request, Comment, Error, Warning, Info); the previous patch fixed the BCF panel's own title, heading, empty-state copy, and topic-title placeholder, and left the rest of the product inconsistent.

Remaining app-visible surfaces now fixed: the Analyze ribbon's "BCF issues" toggle button (a fourth site, alongside the command palette, main toolbar, and workspace-panel controls fixed previously), the compare panel's "Create BCF issue" affordance and "Issue for" header, the auto-created BCF project's default name (`<model>_Issues` → `<model>_Topics`, matching the BCF panel's own default), the landing-page hero animation's "Issue" step label, the MCP playground's BCF category blurb and example export path, and BCF-related copy across three in-app tours (`bcf`, `compare`, `clash`) — tour titles/descriptions plus five step titles/bodies.

Docs updated to match: `docs/index.md`, `README.md`, `docs/guide/quickstart.md`, `docs/guide/bcf.md`, `docs/api/typescript.md`, and the CLI guide/reference's `bcf` examples (`--out topic.bcf`, `bcf list topics.bcf`), which also renamed the example filenames for consistency — they are illustrative only; the CLI has no default BCF filename.

Also reworded now-inconsistent internal comments and JSDoc in the touched files, `@ifc-lite/bcf`'s package README and `createTopic` doc comment, `@ifc-lite/bcf-api`'s README, `@ifc-lite/sdk`'s `bim.bcf` namespace docs, `@ifc-lite/mcp`'s `bcf` tool docblock and fire-rating prompt template, and `@ifc-lite/sandbox`'s clash-to-BCF tool description — all comment/doc-only, no behavior change beyond the CLI's `bcf create` usage-message example (`--title "Issue"` → `--title "Missing door"`, matching the `--help` listing).

Left deliberately unchanged: `bcfHelpers.tsx`'s `TOPIC_TYPES` list and every other real `TopicType` spec value (including the MCP `bcf` tool's `type` default and the sandbox playground's `topicType` default, both `'Issue'`), `ClashPanel`'s unrelated clash-detection "issues", GitHub issue-number references, and `registry.ts`'s `id: 'bcf'` panel key.
