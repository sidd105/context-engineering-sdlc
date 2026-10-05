const STOPWORDS = new Set(
  "a an and are as at be by for from has have in into is it its of on or that the this to was were will with we our you your new must should may can not no all any each when which who what how only whether keep also than then there their them so if but do does".split(
    " ",
  ),
);

/** Lowercase word tokens. Keeps hyphenated words both whole and split. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []) {
    out.push(raw);
    if (raw.includes("-")) out.push(...raw.split("-").filter(Boolean));
  }
  return out;
}

/**
 * Very light suffix stripping so inflections meet: payments/payment,
 * captures/captured/capture, routing/route, policies/policy.
 * Not linguistically correct, only consistent, which is all matching needs.
 */
export function stem(word: string): string {
  if (word.length <= 3 || /(ss|us|is)$/.test(word)) return word; // access, synchronous, analysis
  let w = word;
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (/(s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else {
    for (const suf of ["ations", "ation", "ings", "ing", "ed", "s"]) {
      if (w.endsWith(suf) && w.length - suf.length >= 3) {
        w = w.slice(0, -suf.length);
        break;
      }
    }
  }
  return w.length > 4 && w.endsWith("e") ? w.slice(0, -1) : w;
}

export function terms(text: string): string[] {
  return tokenize(text)
    .filter((t) => !STOPWORDS.has(t) && t.length > 1)
    .map(stem);
}

/** Rough token estimate (~4 chars per token for English prose). Swap for a real tokenizer per model. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Derive a short summary: the first sentence (ignoring "e.g.", "i.e." and
 * list numbering), capped at `max` characters on a word boundary.
 */
export function firstSentence(text: string, max = 180): string {
  const t = text.trim().replace(/\s+/g, " ");
  const re = /[.!?](?=\s+[A-Z`(]|$)/g;
  let end = t.length;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const before = t.slice(0, m.index + 1);
    if (/\b(e\.g|i\.e|etc|vs)\.$/i.test(before) || /(^|\s)\d+\.$/.test(before)) continue;
    end = m.index + 1;
    break;
  }
  const sentence = t.slice(0, end);
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:(]$/, "") + " ...";
}

/**
 * Okapi BM25 over a fixed corpus. Each document is a bag of weighted fields
 * flattened into one term list (titles and tags are repeated to boost them).
 */
export class Bm25Index {
  private readonly docs = new Map<string, Map<string, number>>();
  private readonly lengths = new Map<string, number>();
  private readonly df = new Map<string, number>();
  private avgLen = 0;

  constructor(
    corpus: Iterable<[id: string, terms: string[]]>,
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {
    let total = 0;
    for (const [id, ts] of corpus) {
      const tf = new Map<string, number>();
      for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.docs.set(id, tf);
      this.lengths.set(id, ts.length);
      total += ts.length;
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = this.docs.size ? total / this.docs.size : 0;
  }

  idf(term: string): number {
    const n = this.docs.size;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Score one document. `query` maps term -> query weight (expanded terms get < 1). */
  score(id: string, query: Map<string, number>): { score: number; matched: string[] } {
    const tf = this.docs.get(id);
    if (!tf) return { score: 0, matched: [] };
    const len = this.lengths.get(id) ?? 0;
    let s = 0;
    const matched: string[] = [];
    for (const [term, qw] of query) {
      const f = tf.get(term);
      if (!f) continue;
      matched.push(term);
      const norm = f * (this.k1 + 1) / (f + this.k1 * (1 - this.b + (this.b * len) / (this.avgLen || 1)));
      s += qw * this.idf(term) * norm;
    }
    return { score: s, matched };
  }
}

/** Whole-phrase containment on word boundaries ("payment service" in "add a payment service hook"). */
export function containsPhrase(text: string, phrase: string): boolean {
  const p = (phrase.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []).join(" ");
  if (!p) return false;
  const t = ` ${tokenize(text).join(" ")} `;
  return t.includes(` ${p} `) || t.includes(` ${p.replace(/-/g, " ")} `);
}
