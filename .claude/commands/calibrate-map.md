---
description: Identify enemy species from a maplestory.ai calibration capture
argument-hint: <path to data/calibrations/<name>/CALIBRATE.md>
---

You are calibrating template-based perception for a Maplestory map.

1. Read the file at `$ARGUMENTS`. It is a CALIBRATE.md prompt bundle generated
   by `maplestory.ai calibrate`. Follow every instruction inside it.
2. Use the Read tool to view each frame listed in the bundle as an image.
3. Cross-reference frames to identify distinct enemy species and their
   animation states.
4. Write `manifest-source.json` exactly at the path the bundle specifies, with
   the exact JSON shape it requires. Use only the listed `source_frame`
   filenames.
5. Pick **1–3 variants per species** (idle / move / attack). More variants =
   better runtime recall. Tight bboxes (no background, no overlapping mobs).
6. Do **not** include the player, runes, portals, NPCs, or UI.
7. After writing the JSON, print a one-line summary: `<N> species, <M> templates total`.

Stop after writing the JSON. The user will run `npm run dev -- crop-templates`
to generate the final PNG crops.
