# Appendix C — Sources

## Repositories analysed (code read directly)
- `LTplus-AG/ifc-lite` (branch `claude/stoic-cannon-6hceqo`, Oct 2026): packages/ids, rules, data, codegen, sdk (bsdd), mcp, cli, query, create, mutations, collab, apps/viewer; AGENTS.md; docs/guide/viewer-assistant.md; docs/architecture/viewer-ai-plan.md
- `louistrue/IDS-LLM-Service` (commit cd68fe8, 2025-12-17)
- `louistrue/ids-flow` (HEAD 48dfb43, 2026-07-01)

## Standards and official tools
- buildingSMART IDS repository, developer guide: https://github.com/buildingSMART/IDS/blob/master/Documentation/developer-guide.md
- IDS milestones (1.1): https://github.com/buildingSMART/IDS/milestones , https://github.com/buildingSMART/IDS/milestone/2
- IDS issues cited: #48, #62, #114, #116, #154, #178, #200, #203, #206, #247, #259, #279, #339, #342, #356, #379, #380, #386, #391, #392, #393, #397, #403, #416, #418, #420, #422, #423, #430, #447, #448
- Forum, validating IDS files: https://forums.buildingsmart.org/t/how-to-validate-ids-files/5993
- buildingSMART NuGet (ids-audit-tool): https://www.nuget.org/profiles/buildingSMART
- Software implementations registry: https://technical.buildingsmart.org/ids-software-implementations/

## Tools
Per-tool research sources are kept in the private plan package (ADR-014: vendor analysis stays out of the public repo).

## Research
- Ishigaki-IDS-Bench (arXiv 2605.22079): https://arxiv.org/pdf/2605.22079
- Ishigaki-IDS (arXiv 2606.08545): https://arxiv.org/pdf/2606.08545 ; model: https://featherless.ai/models/ONESTRUCTION/Ishigaki-IDS-8B
- LLM compliance checking (TUM, EC3 2025): https://mediatum.ub.tum.de/doc/1781947/66amsnnaqbygipuftj8b88oqv.2025_HELLIN_EC3.pdf

## Planning frameworks
- Working Backwards / PR-FAQ (Amazon)
- Shape Up (Basecamp): https://basecamp.com/shapeup
- ADRs (Michael Nygard): https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions
- arc42: https://arc42.org ; C4 model: https://c4model.com

*Note: several sites (buildingsmart.org, osarch.org, arxiv.org) could not be fetched directly during research. Claims from them come from search excerpts and are marked (unverified) in the landscape doc where unconfirmed.*
