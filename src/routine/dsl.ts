import type { GameState } from '@/core/types'

export type Predicate = (state: GameState) => boolean

const ALLOWED_FN = ['mobs_in_range', 'buff_expired', 'stuck_seconds']
const ALLOWED_VAR = ['hp', 'mp', 'rune_active']

const TOKEN_RE = /^\s*(?:(\d+(?:\.\d+)?)|(<=|>=|!=|==|<|>)|(&&|\|\|)|(\(|\))|([a-z_]+))/

interface Tok {
  kind: 'num' | 'cmp' | 'logic' | 'paren' | 'ident'
  value: string
}

function tokenize(input: string): Tok[] {
  const toks: Tok[] = []
  let s = input
  while (s.trim().length) {
    const m = TOKEN_RE.exec(s)
    if (!m) throw new Error(`when: invalid token at "${s.slice(0, 20)}"`)
    s = s.slice(m[0].length)
    if (m[1]) toks.push({ kind: 'num', value: m[1] })
    else if (m[2]) toks.push({ kind: 'cmp', value: m[2] })
    else if (m[3]) toks.push({ kind: 'logic', value: m[3] })
    else if (m[4]) toks.push({ kind: 'paren', value: m[4] })
    else if (m[5]) toks.push({ kind: 'ident', value: m[5] })
  }
  return toks
}

function validateIdents(toks: Tok[]): void {
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].kind === 'ident') {
      const name = toks[i].value
      const isFn = i + 1 < toks.length && toks[i + 1].kind === 'paren' && toks[i + 1].value === '('
      if (isFn) {
        if (!ALLOWED_FN.includes(name)) throw new Error(`when: function not allowed: ${name}`)
      } else {
        if (!ALLOWED_VAR.includes(name)) throw new Error(`when: identifier not allowed: ${name}`)
      }
    }
  }
}

function evalSrc(src: string, state: GameState): boolean {
  const ctx = {
    hp: state.player.hp,
    mp: state.player.mp,
    rune_active: state.flags.runeActive,
    mobs_in_range: (px: number) => state.enemies.filter((e) => e.distancePx <= px).length,
    buff_expired: (_n: string) => false,
    stuck_seconds: () => 0,
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function(...Object.keys(ctx), `return (${src})`)
  return Boolean(fn(...Object.values(ctx)))
}

export function compileWhen(expr: string): Predicate {
  const toks = tokenize(expr)
  validateIdents(toks)
  return (state) => evalSrc(expr, state)
}
