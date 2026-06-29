// Resilient changelog generator.
//
// The release pipeline uses @changesets/changelog-github to enrich each changelog
// entry with PR / author links. That enrichment makes a GitHub GraphQL request
// (via @changesets/get-github-info). When that request fails — e.g. undici
// "Invalid response body ... Premature close" under Node 24, or a transient GitHub
// API hiccup — changesets THROWS and the entire `changeset version` step (and thus
// every package release) is blocked. Changelog enrichment is optional and must
// never be able to block a release.
//
// This wraps the GitHub generator and, on ANY error, falls back to the plain
// default changelog (the changeset summary). Normal runs are unchanged (rich
// changelog with PR links); only a failed enrichment degrades to a plain entry.
//
// Loaded by @changesets/apply-release-plan, which resolves `config.changelog[0]`
// from the `.changeset/` directory, so config references this as
// `"./changelog-resilient.cjs"`. The export shape (CJS `__esModule` + `default`)
// mirrors @changesets/changelog-github so the loader's default-unwrap works.

const github = require("@changesets/changelog-github").default;
const fallback = require("@changesets/cli/changelog").default;

async function getReleaseLine(changeset, type, options) {
  try {
    return await github.getReleaseLine(changeset, type, options);
  } catch (err) {
    console.error(
      "[changelog] GitHub enrichment failed (" +
        (err && err.message) +
        "); falling back to the plain changeset summary.",
    );
    return fallback.getReleaseLine(changeset, type, options);
  }
}

async function getDependencyReleaseLine(changesets, dependenciesUpdated, options) {
  try {
    return await github.getDependencyReleaseLine(changesets, dependenciesUpdated, options);
  } catch (err) {
    console.error(
      "[changelog] GitHub dependency enrichment failed (" +
        (err && err.message) +
        "); falling back to a plain dependency list.",
    );
    return fallback.getDependencyReleaseLine(changesets, dependenciesUpdated, options);
  }
}

Object.defineProperty(exports, "__esModule", { value: true });
exports.default = { getReleaseLine, getDependencyReleaseLine };
