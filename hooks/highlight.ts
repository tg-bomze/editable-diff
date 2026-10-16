// Syntax highlighting for the editor: a small tokenizer per language family,
// one line at a time, carrying block comments and multi-line strings over.
// Pure: no `$`, no state.

export type TokenKind =
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'type'
  | 'function'
  | 'constant'
  | 'key'
  | 'heading'

/** A coloured span of one line, [from, to) in code units. */
export type Token = { from: number; to: number; kind: TokenKind }

/** What a line leaves open for the next: nothing, a block comment, a string by its delimiter, a code fence. */
export type LineState = string

type Lang = {
  lineComment: string[]
  block?: [string, string]
  quotes: string[]
  /** Delimiters of strings that may span lines, longest first. */
  multi: string[]
  keywords: Set<string>
  constants: Set<string>
  /** Capitalized identifiers are types. */
  types: boolean
  caseless?: boolean
  /** `"key":` and `key:` are keys. */
  keys?: 'json' | 'yaml' | 'css'
  markdown?: boolean
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean))

const JS = words(`break case catch class const continue debugger default delete do else export extends finally
  for from function if import in instanceof let new of return super switch this throw try typeof var void while
  with yield async await as type interface enum implements private protected public readonly static declare
  namespace module abstract keyof infer is satisfies get set`)
const PY = words(`and as assert async await break class continue def del elif else except finally for from global
  if import in is lambda nonlocal not or pass raise return try while with yield match case self cls print`)
const GO = words(`break case chan const continue default defer else fallthrough for func go goto if import
  interface map package range return select struct switch type var`)
const RUST = words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop match
  mod move mut pub ref return self Self static struct super trait type unsafe use where while`)
const C = words(`if else for while do switch case default break continue return goto struct union enum typedef
  class public private protected static const void int char float double long short unsigned signed bool new
  delete this try catch throw finally import package extends implements interface abstract final override
  virtual namespace using template typename sizeof var val fun let func guard extension protocol self in is
  when object companion data sealed suspend internal open lateinit inline auto string`)
const SH = words(`if then else elif fi case esac for while until do done in function select return local export
  readonly declare unset source alias echo exit set`)
const RUBY = words(`def end class module if elsif else unless while until for in do begin rescue ensure return
  yield self require require_relative include extend attr_accessor attr_reader then case when puts`)
const SQL = words(`select from where and or not insert into values update set delete create table index drop
  alter join left right inner outer full on group by order having limit offset as distinct union all is in like
  between case when then else end primary key foreign references default with returning view`)
const CONSTANTS = words('true false null undefined NaN Infinity None True False nil iota')

const cLike = (keywords: Set<string>): Lang => ({
  lineComment: ['//'],
  block: ['/*', '*/'],
  quotes: ['"', "'"],
  multi: ['`'],
  keywords,
  constants: CONSTANTS,
  types: true,
})
const hashLike = (keywords: Set<string>, multi: string[] = []): Lang => ({
  lineComment: ['#'],
  quotes: ['"', "'"],
  multi,
  keywords,
  constants: CONSTANTS,
  types: true,
})

const LANGS: Record<string, Lang> = {
  js: cLike(JS),
  go: { ...cLike(GO), quotes: ['"', "'"], multi: ['`'] },
  rust: { ...cLike(RUST), multi: [] },
  c: { ...cLike(C), multi: ['"""'] },
  py: hashLike(PY, ['"""', "'''"]),
  sh: { ...hashLike(SH), types: false },
  ruby: hashLike(RUBY),
  yaml: { ...hashLike(new Set()), types: false, keys: 'yaml' },
  toml: { ...hashLike(new Set()), types: false, keys: 'yaml', multi: ['"""', "'''"] },
  json: {
    lineComment: ['//'],
    quotes: ['"'],
    multi: [],
    keywords: new Set(),
    constants: CONSTANTS,
    types: false,
    keys: 'json',
  },
  css: {
    lineComment: [],
    block: ['/*', '*/'],
    quotes: ['"', "'"],
    multi: [],
    keywords: new Set(),
    constants: new Set(),
    types: false,
    keys: 'css',
  },
  sql: {
    lineComment: ['--'],
    block: ['/*', '*/'],
    quotes: ["'", '"'],
    multi: [],
    keywords: SQL,
    constants: CONSTANTS,
    types: false,
    caseless: true,
  },
  html: {
    lineComment: [],
    block: ['<!--', '-->'],
    quotes: ['"', "'"],
    multi: [],
    keywords: new Set(),
    constants: new Set(),
    types: false,
  },
  md: {
    lineComment: [],
    quotes: [],
    multi: [],
    keywords: new Set(),
    constants: new Set(),
    types: false,
    markdown: true,
  },
}

const BY_EXT: Record<string, string> = {
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'js',
  tsx: 'js',
  mts: 'js',
  cts: 'js',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cc: 'c',
  cpp: 'c',
  hpp: 'c',
  cs: 'c',
  java: 'c',
  kt: 'c',
  kts: 'c',
  swift: 'c',
  scala: 'c',
  dart: 'c',
  php: 'c',
  m: 'c',
  zig: 'c',
  py: 'py',
  pyi: 'py',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  fish: 'sh',
  rb: 'ruby',
  r: 'sh',
  pl: 'sh',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'toml',
  cfg: 'toml',
  env: 'sh',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  sql: 'sql',
  html: 'html',
  htm: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  svelte: 'html',
  md: 'md',
  mdx: 'md',
  markdown: 'md',
}

/** The language a path is drawn in, or undefined to draw it plain. */
export function languageOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'dockerfile' || name === 'makefile' || name.startsWith('.env')) return 'sh'
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''

  return BY_EXT[ext]
}

const isIdentStart = (c: string | undefined) => c !== undefined && /[A-Za-z_$]/.test(c)
const isIdent = (c: string | undefined) => c !== undefined && /[\w$]/.test(c)

/** Index just past the closing `delim` from `i`, honouring backslash escapes; -1 when the line ends first. */
function closeAt(line: string, i: number, delim: string, escapes: boolean): number {
  for (let j = i; j < line.length; j++) {
    if (escapes && line[j] === '\\') {
      j++
      continue
    }
    if (line.startsWith(delim, j)) return j + delim.length
  }

  return -1
}

function markdownLine(line: string, state: LineState): { tokens: Token[]; end: LineState } {
  const tokens: Token[] = []
  if (/^\s*(```|~~~)/.test(line)) {
    return { tokens: [{ from: 0, to: line.length, kind: 'comment' }], end: state === 'fence' ? '' : 'fence' }
  }
  if (state === 'fence') return { tokens: [{ from: 0, to: line.length, kind: 'string' }], end: 'fence' }
  if (/^\s{0,3}#{1,6}\s/.test(line)) return { tokens: [{ from: 0, to: line.length, kind: 'heading' }], end: '' }
  const quote = /^\s*>/.exec(line)
  if (quote) tokens.push({ from: 0, to: line.length, kind: 'comment' })
  const list = /^(\s*)([-*+]|\d+[.)])\s/.exec(line)
  if (list) tokens.push({ from: list[1]!.length, to: list[1]!.length + list[2]!.length, kind: 'keyword' })
  const code = /`[^`]+`/g
  for (let m = code.exec(line); m; m = code.exec(line))
    tokens.push({ from: m.index, to: m.index + m[0].length, kind: 'string' })
  const link = /\]\(([^)]+)\)/g
  for (let m = link.exec(line); m; m = link.exec(line))
    tokens.push({ from: m.index + 2, to: m.index + 2 + m[1]!.length, kind: 'constant' })

  return { tokens, end: '' }
}

/** One line's tokens, given what the line before left open, and what this one leaves open. */
export function tokenize(
  line: string,
  state: LineState,
  language: string | undefined,
): { tokens: Token[]; end: LineState } {
  const lang = language ? LANGS[language] : undefined
  if (!lang) return { tokens: [], end: '' }
  if (lang.markdown) return markdownLine(line, state)

  const tokens: Token[] = []
  let i = 0
  if (state === 'block' && lang.block) {
    const end = closeAt(line, 0, lang.block[1], false)
    if (end < 0) return { tokens: [{ from: 0, to: line.length, kind: 'comment' }], end: 'block' }
    tokens.push({ from: 0, to: end, kind: 'comment' })
    i = end
  } else if (state.startsWith('str:')) {
    const delim = state.slice(4)
    const end = closeAt(line, 0, delim, true)
    if (end < 0) return { tokens: [{ from: 0, to: line.length, kind: 'string' }], end: state }
    tokens.push({ from: 0, to: end, kind: 'string' })
    i = end
  }

  if (lang.keys === 'yaml') {
    const key = /^(\s*-?\s*)([\w.\-"' ]+?)(\s*[:=])(\s|$)/.exec(line.slice(i))
    if (key && i === 0) tokens.push({ from: key[1]!.length, to: key[1]!.length + key[2]!.length, kind: 'key' })
  }

  while (i < line.length) {
    const c = line[i]!
    if (lang.lineComment.some(lc => line.startsWith(lc, i)) && (c !== '#' || i === 0 || /\s/.test(line[i - 1]!))) {
      tokens.push({ from: i, to: line.length, kind: 'comment' })
      return { tokens, end: '' }
    }
    if (lang.block && line.startsWith(lang.block[0], i)) {
      const end = closeAt(line, i + lang.block[0].length, lang.block[1], false)
      if (end < 0) {
        tokens.push({ from: i, to: line.length, kind: 'comment' })
        return { tokens, end: 'block' }
      }
      tokens.push({ from: i, to: end, kind: 'comment' })
      i = end
      continue
    }
    const multi = lang.multi.find(d => line.startsWith(d, i))
    if (multi) {
      const end = closeAt(line, i + multi.length, multi, true)
      if (end < 0) {
        tokens.push({ from: i, to: line.length, kind: 'string' })
        return { tokens, end: `str:${multi}` }
      }
      tokens.push({ from: i, to: end, kind: 'string' })
      i = end
      continue
    }
    if (lang.quotes.includes(c)) {
      // A Rust or C lifetime/char like 'a is short; an unclosed quote runs to the line's end.
      let end = closeAt(line, i + 1, c, true)
      if (end < 0) end = line.length
      let kind: TokenKind = 'string'
      if (lang.keys === 'json' && /^\s*:/.test(line.slice(end))) kind = 'key'
      tokens.push({ from: i, to: end, kind })
      i = end
      continue
    }
    if (/\d/.test(c) && !isIdent(line[i - 1])) {
      const m = /^(0[xob][\da-f_]+|\d[\d_]*(\.\d[\d_]*)?(e[+-]?\d+)?)[a-z%]*/i.exec(line.slice(i))!
      tokens.push({ from: i, to: i + m[0].length, kind: 'number' })
      i += m[0].length
      continue
    }
    if (lang.keys === 'css' && c === '#' && /[\da-f]{3,8}\b/i.test(line.slice(i + 1, i + 9))) {
      const m = /^#[\da-f]{3,8}/i.exec(line.slice(i))!
      tokens.push({ from: i, to: i + m[0].length, kind: 'number' })
      i += m[0].length
      continue
    }
    if (isIdentStart(c) || (lang.keys === 'css' && c === '-' && isIdentStart(line[i + 1]))) {
      let j = i + 1
      while (j < line.length && (isIdent(line[j]) || (lang.keys === 'css' && line[j] === '-'))) j++
      const word = line.slice(i, j)
      const after = line.slice(j)
      const key = lang.caseless ? word.toLowerCase() : word
      let kind: TokenKind | undefined
      if (lang.keys === 'css' && /^\s*:(?!:)/.test(after) && !/[{]/.test(after)) kind = 'key'
      else if (lang.keywords.has(key)) kind = 'keyword'
      else if (lang.constants.has(word)) kind = 'constant'
      else if (/^\s*\(/.test(after)) kind = 'function'
      else if (lang.types && /^[A-Z]/.test(word) && /[a-z]/.test(word)) kind = 'type'
      else if (lang.types && word.length > 1 && /^[A-Z][A-Z0-9_]+$/.test(word)) kind = 'constant'
      if (kind) tokens.push({ from: i, to: j, kind })
      i = j
      continue
    }
    i++
  }

  return { tokens, end: '' }
}

/** The state each line starts in, for a whole text: `states[n]` is what line n opens with. */
export function lineStates(lines: readonly string[], language: string | undefined): LineState[] {
  const states: LineState[] = []
  let state: LineState = ''
  for (const line of lines) {
    states.push(state)
    state = language ? tokenize(line, state, language).end : ''
  }

  return states
}
