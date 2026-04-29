export const SYSTEM_PROMPT = `You are reverse-engineering a Maplestory farming demonstration into a runtime-ready routine YAML. You receive sampled gameplay frames + a keystroke log + a vitals timeline. You output a STRICT JSON document matching the routine schema, wrapped in a single \`\`\`json fenced block. Do not include any prose outside the fence. The bot already has its mob templates set up via 'import-sprites'; your job is the BEHAVIOUR (what to press, when, where to walk), not mob identification.`

export function buildUserPrompt(opts: {
  framesSampled: number
  resolution: [number, number]
  windowTitle: string
  inputsJsonl: string
  vitalsJsonl: string
}): string {
  return `Analyze this Maplestory farming session.

- Resolution: ${opts.resolution.join('x')}
- Window title: ${opts.windowTitle}
- Frames sampled: ${opts.framesSampled}

INPUTS LOG (truncated):
${opts.inputsJsonl.slice(0, 4000)}

VITALS LOG (truncated):
${opts.vitalsJsonl.slice(0, 4000)}

Output a complete routine JSON. Required keys:

- game: "maplestory"
- resolution, window_title
- regions { hp, mp, minimap }   — fixed pixel rectangles in screen coords
- reflex                         — HP/MP potion rules tied to regions
- perception:
    - template_dir              — path the user already populated via import-sprites; if unsure, leave a placeholder like "data/templates/<map>"
    - fps                        — 8–12 typical
    - match_threshold            — 0.7–0.8 typical
    - stride                     — 2 default
    - search_region (optional)  — crop to "near-player" zone for speed
    - combat_anchor (optional)  — only set if you can see the camera is off-center
- rotation                       — perception-gated 'when' rules + 'every' buffs
- movement                       — primitives compiled from the MINIMAP trajectory
- bounds                         — min/max minimap coords seen across the recording
- minimap_player_color           — { rgb, tolerance } of the dot in the minimap
- stop_condition                 — include out_of_bounds and a duration cap

Notes:
- Mob templates are managed separately (data/templates/<map>/manifest.json). DO NOT
  reference YOLO, classes lists, or confidence thresholds — those are gone.
- Use \`when: 'mobs_in_range(<px>) >= <N>'\` style for attacks.
- Movement primitives: walk_to_x, jump_left, jump_right, drop_down, wait.
- Mark "unreviewed": true at the top level so the user must review.`
}
