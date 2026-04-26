import { Routine } from '@/routine/schema'
import type { Routine as RoutineT } from '@/routine/schema'

const FENCE = /```(?:json)?\s*([\s\S]*?)```/

export type ExtractResult =
  | { ok: true; routine: RoutineT }
  | { ok: false; error: string }

export function extractAndValidate(text: string): ExtractResult {
  let body = text.trim()
  const m = FENCE.exec(body)
  if (m) body = m[1].trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (e) {
    return { ok: false, error: `JSON parse error: ${(e as Error).message}` }
  }
  const r = Routine.safeParse(parsed)
  if (!r.success) return { ok: false, error: r.error.message }
  return { ok: true, routine: r.data }
}
