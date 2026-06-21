---
"@ifc-lite/viewer": minor
---

Clash panel overhaul driven by user feedback (#1271–#1281):

- **Find duplicates** — one-click scan for duplicate / coincident objects, the
  first check on a single discipline model (#1280), plus single-model framing in
  the empty state (#1271).
- **Sort by severity / overlap depth / distance** and an info box explaining how
  severity (element-type pair) and hard-vs-clearance / tol-vs-gap work (#1272,
  #1274).
- **Hide touching** toggle + a "touch" badge for ≈0 m contacts (#1273).
- **Step through a pair** — expandable rows show each object with a plain-language
  description and per-element select (#1276).
- **Isolate** the clashing pair (per-row button + "isolate on select" toggle) so
  a clash can be judged in isolation (#1275); the "Highlight all" button is
  relabelled and explained (#1278).
- **Create a BCF topic** directly from a clash into the in-app issue tracker, no
  download/re-import round-trip (#1279).
