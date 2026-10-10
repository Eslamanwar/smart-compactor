// List prices, USD per million tokens (platform.claude.com/docs/en/about-claude/pricing).
// Matched in order, so the 5.5 rows sit before the family fallbacks.
export type Price = { input: number; write5m: number; write1h: number; read: number; output: number }

const PRICES: readonly (readonly [RegExp, Price])[] = [
  [/opus-5-5/, { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 }],
  [/opus/, { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 }],
  [/sonnet-5-5/, { input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 }],
  [/sonnet/, { input: 2, write5m: 2.5, write1h: 4, read: 0.2, output: 10 }],
  [/haiku/, { input: 0.1, write5m: 0.125, write1h: 0.2, read: 0.01, output: 0.5 }],
  [/fable/, { input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 }],
]

// The model whose cache reads cost less, for the "move to 5.5" hint.
const CHEAPER: readonly (readonly [RegExp, string])[] = [
  [/opus-5(?!-5)|opus-4/, 'claude-opus-5-5'],
  [/sonnet-5(?!-5)|sonnet-4/, 'claude-sonnet-5-5'],
]

export const priceOf = (model: string): Price | undefined =>
  PRICES.find(([re]) => re.test(model))?.[1]

export const cheaperModel = (model: string): string | undefined =>
  CHEAPER.find(([re]) => re.test(model))?.[1]

export const writePrice = (p: Price, ttl: string) => (ttl === '5m' ? p.write5m : p.write1h)

export type Split = { read: number; write: number; output: number; input: number }

/** One turn's cost in USD, split the way the chart stacks it. */
export const costSplit = (
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number },
  p: Price,
  ttl: string,
): Split => ({
  read: (usage.cache_read_input_tokens * p.read) / 1e6,
  write: (usage.cache_creation_input_tokens * writePrice(p, ttl)) / 1e6,
  output: (usage.output_tokens * p.output) / 1e6,
  input: (usage.input_tokens * p.input) / 1e6,
})

export const usd = (n: number) => (n >= 10 ? `$${n.toFixed(1)}` : n >= 0.1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`)

export const kTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}K`)
