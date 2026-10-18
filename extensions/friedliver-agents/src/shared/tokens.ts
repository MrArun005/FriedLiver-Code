// A cl100k-style token estimate without the tokenizer's 2 MB of merge tables: text is split
// with cl100k's own pre-tokenizer pattern, then each piece costs what BPE typically makes of
// it. Within ~15% of cl100k on code and prose; the token bench uses the real tokenizer in CI.
// ponytail: an estimate for budgets and readouts; swap in js-tiktoken if exact counts are ever billed.
const PIECE = /'(?:[sdmt]|ll|ve|re)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

export function estimateTokens(text: string): number {
  let n = 0;
  for (const [p] of text.matchAll(PIECE)) {
    if (/\p{L}/u.test(p)) n += Math.ceil(p.length / 6);
    else if (/^\s+$/.test(p)) n += Math.ceil(p.length / 16);
    else n += Math.ceil(p.trim().length / 3) || 1;
  }
  return n;
}
