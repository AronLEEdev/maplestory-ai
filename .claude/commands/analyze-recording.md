---
description: Analyze a maplestory.ai recording and produce a routine YAML
argument-hint: <path to ANALYZE.md>
---

You are analyzing a Maplestory farming demonstration captured by `maplestory.ai record`. Your job:

1. Read the prompt bundle at `$ARGUMENTS` (typically `recordings/<name>/ANALYZE.md`).
2. Follow every instruction inside it. The bundle lists exact frame paths, input/vital log paths, output YAML path, and the JSON-shape contract.
3. Use the Read tool to load every referenced file. Inspect frames as images.
4. Produce the routine YAML at the specified output path. Mark `unreviewed: true` at the top.
5. After writing, run `npm run dev -- run <output> --mode dry-run` and confirm schema validation passes. If it fails, read the error, fix the YAML, retry (max 2 retries).
6. Print a one-line summary of what the routine farms (map, rotation keys, duration cap).

Do not invent values you cannot infer from the recording. If a field is genuinely unclear (e.g. minimap player color in a frame with no visible dot), pick the documented default and note it in a YAML comment.
