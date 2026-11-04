---
---

Orient Gaussian captures like point clouds by default, apply the IFC federation render-origin offset during ingest, and preserve a per-capture up-axis override through reload and federation setup restore.

Captures follow subsequent federation frame changes, including capture-first loads and anchor removal. Captures and old saved setups without explicit placement previously used raw identity coordinates; they now reopen rotated from Z-up. Choose Source up-axis → Y up to restore the previous orientation and save the setup again.
