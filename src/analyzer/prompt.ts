export const SYSTEM_PROMPT = `You are an expert reverse-engineer of Maplestory farming demonstrations. You receive sampled gameplay frames + a keystroke log + a vitals timeline. You output a STRICT JSON document matching the routine schema, wrapped in a single \`\`\`json fenced block. Do not include any prose outside the fence.`

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
- game ("maplestory"), resolution, window_title
- regions { hp, mp, minimap }
- reflex (HP/MP potion rules)
- perception { model: "yolov8n-maplestory", fps, classes, confidence_threshold }
- rotation (perception-gated when rules + every-cadence buffs)
- movement { primitives, loop, pause_while_attacking }
- bounds { x: [min, max], y: [min, max] } — derived from MINIMAP-coordinate extents observed across the recording. The minimap is the small rectangle in the top-right; the player appears as a bright colored dot. Bounds are in minimap-local coords, NOT screen coords.
- minimap_player_color { rgb: [r, g, b], tolerance } — the dot color you observed in the minimap region of the sampled frames.
- movement.primitives — compile from the player's MINIMAP trajectory: \`walk_to_x\` uses minimap x; \`jump_left\`/\`jump_right\`/\`drop_down\` map to vertical platform transitions in minimap y.
- stop_condition (include \`out_of_bounds: { margin: 10 }\` so the bot aborts on knockback)

Use \`when: 'mobs_in_range(<px>) >= <N>'\` style for attacks.
Mark "unreviewed": true at the top level.`
}
