import type { GameState } from '@/core/types'

export type Predicate = (state: GameState) => boolean

const ALLOWED_FN = ['mobs_in_range', 'buff_expired', 'stuck_seconds'] as const
const ALLOWED_VAR = ['hp', 'mp', 'rune_active'] as const

type FnName = (typeof ALLOWED_FN)[number]
type VarName = (typeof ALLOWED_VAR)[number]

type Tok =
  | { kind: 'num'; value: number }
  | { kind: 'cmp'; value: '<=' | '>=' | '!=' | '==' | '<' | '>' }
  | { kind: 'logic'; value: '&&' | '||' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' }
  | { kind: 'ident'; value: string }

const TOKEN_RE = /^\s*(?:(\d+(?:\.\d+)?)|(<=|>=|!=|==|<|>)|(&&|\|\|)|(\()|(\))|(,)|([a-z_]+))/

function tokenize(input: string): Tok[] {
  const toks: Tok[] = []
  let s = input
  while (s.trim().length) {
    const m = TOKEN_RE.exec(s)
    if (!m) throw new Error(`when: invalid token at "${s.slice(0, 20)}"`)
    s = s.slice(m[0].length)
    if (m[1] !== undefined) toks.push({ kind: 'num', value: Number(m[1]) })
    else if (m[2]) toks.push({ kind: 'cmp', value: m[2] as Tok extends { kind: 'cmp' } ? Tok['value'] : never })
    else if (m[3]) toks.push({ kind: 'logic', value: m[3] as '&&' | '||' })
    else if (m[4]) toks.push({ kind: 'lparen' })
    else if (m[5]) toks.push({ kind: 'rparen' })
    else if (m[6]) toks.push({ kind: 'comma' })
    else if (m[7]) toks.push({ kind: 'ident', value: m[7] })
  }
  return toks
}

// AST
type Node =
  | { type: 'num'; value: number }
  | { type: 'var'; name: VarName }
  | { type: 'call'; name: FnName; args: Node[] }
  | { type: 'cmp'; op: '<=' | '>=' | '!=' | '==' | '<' | '>'; l: Node; r: Node }
  | { type: 'logic'; op: '&&' | '||'; l: Node; r: Node }

class Parser {
  private i = 0
  constructor(private toks: Tok[]) {}

  parse(): Node {
    const node = this.expr()
    if (this.i < this.toks.length) {
      throw new Error(`when: unexpected trailing tokens starting at #${this.i}`)
    }
    return node
  }

  private peek(): Tok | undefined {
    return this.toks[this.i]
  }
  private next(): Tok {
    const t = this.toks[this.i++]
    if (!t) throw new Error('when: unexpected end of expression')
    return t
  }

  // expr := orExpr
  // orExpr := andExpr ('||' andExpr)*
  // andExpr := cmpExpr ('&&' cmpExpr)*
  // cmpExpr := atom (cmp atom)?
  // atom := num | ident | ident '(' args? ')' | '(' expr ')'
  private expr(): Node {
    return this.orExpr()
  }
  private orExpr(): Node {
    let n = this.andExpr()
    while (this.peek()?.kind === 'logic' && (this.peek() as { value: string }).value === '||') {
      this.next()
      n = { type: 'logic', op: '||', l: n, r: this.andExpr() }
    }
    return n
  }
  private andExpr(): Node {
    let n = this.cmpExpr()
    while (this.peek()?.kind === 'logic' && (this.peek() as { value: string }).value === '&&') {
      this.next()
      n = { type: 'logic', op: '&&', l: n, r: this.cmpExpr() }
    }
    return n
  }
  private cmpExpr(): Node {
    const l = this.atom()
    if (this.peek()?.kind === 'cmp') {
      const op = (this.next() as { value: '<=' | '>=' | '!=' | '==' | '<' | '>' }).value
      const r = this.atom()
      return { type: 'cmp', op, l, r }
    }
    return l
  }
  private atom(): Node {
    const t = this.peek()
    if (!t) throw new Error('when: expected atom')
    if (t.kind === 'num') {
      this.next()
      return { type: 'num', value: t.value }
    }
    if (t.kind === 'lparen') {
      this.next()
      const inner = this.expr()
      const close = this.next()
      if (close.kind !== 'rparen') throw new Error('when: expected )')
      return inner
    }
    if (t.kind === 'ident') {
      this.next()
      const name = t.value
      if (this.peek()?.kind === 'lparen') {
        if (!(ALLOWED_FN as readonly string[]).includes(name)) {
          throw new Error(`when: function not allowed: ${name}`)
        }
        this.next() // (
        const args: Node[] = []
        if (this.peek()?.kind !== 'rparen') {
          args.push(this.expr())
          while (this.peek()?.kind === 'comma') {
            this.next()
            args.push(this.expr())
          }
        }
        const close = this.next()
        if (close.kind !== 'rparen') throw new Error('when: expected ) after args')
        return { type: 'call', name: name as FnName, args }
      }
      if (!(ALLOWED_VAR as readonly string[]).includes(name)) {
        throw new Error(`when: identifier not allowed: ${name}`)
      }
      return { type: 'var', name: name as VarName }
    }
    throw new Error(`when: unexpected token kind: ${t.kind}`)
  }
}

function evalNode(n: Node, state: GameState): number | boolean {
  switch (n.type) {
    case 'num':
      return n.value
    case 'var':
      switch (n.name) {
        case 'hp':
          return state.player.hp
        case 'mp':
          return state.player.mp
        case 'rune_active':
          return state.flags.runeActive
      }
      throw new Error(`when: unknown var ${(n as { name: string }).name}`)
    case 'call':
      switch (n.name) {
        case 'mobs_in_range': {
          const px = Number(evalNode(n.args[0], state))
          return state.enemies.filter((e) => e.distancePx <= px).length
        }
        case 'buff_expired':
          return false // v1 stub — buff timers tracked in routine runner, not yet plumbed here
        case 'stuck_seconds':
          return 0 // v1 stub — stuck timer not yet plumbed here
      }
      throw new Error(`when: unknown call ${(n as { name: string }).name}`)
    case 'cmp': {
      const l = Number(evalNode(n.l, state))
      const r = Number(evalNode(n.r, state))
      const op = n.op
      if (op === '<') return l < r
      if (op === '>') return l > r
      if (op === '<=') return l <= r
      if (op === '>=') return l >= r
      if (op === '==') return l === r
      if (op === '!=') return l !== r
      return false
    }
    case 'logic': {
      const lv = Boolean(evalNode(n.l, state))
      if (n.op === '&&') return lv && Boolean(evalNode(n.r, state))
      return lv || Boolean(evalNode(n.r, state))
    }
  }
}

export function compileWhen(expr: string): Predicate {
  const toks = tokenize(expr)
  const ast = new Parser(toks).parse()
  return (state) => Boolean(evalNode(ast, state))
}
