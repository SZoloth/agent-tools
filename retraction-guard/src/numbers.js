/**
 * Number extraction and normalization.
 *
 * Every spelling of the same quantity normalizes to one value, so "1,000+",
 * "1000", "1k" and "a thousand" all compare equal. Matching on value, not
 * spelling, is what stops an agent from slipping a retracted number back in
 * by rewording it.
 */

const WORD_VALUES = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const SCALE_WORDS = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };
const SUFFIX_SCALE = { k: 1_000, m: 1_000_000, mm: 1_000_000, b: 1_000_000_000, bn: 1_000_000_000 };

const MONTHS = new Set([
  "jan", "january", "feb", "february", "mar", "march", "apr", "april", "may", "jun", "june",
  "jul", "july", "aug", "august", "sep", "sept", "september", "oct", "october", "nov", "november",
  "dec", "december",
]);

// A digit run (with commas or a decimal point), optional currency, scale suffix, plus, percent or multiplier.
const DIGIT_RE = /(?<![\p{L}\p{N}.,])(\$|£|€)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:(k|mm|m|bn|b)(?![\p{L}]))?(\+)?(?:\s?(%|×| percent\b)|(x)(?![\p{L}]))?/giu;
// Word numbers: "a thousand", "twelve", "two hundred", "six".
const WORD_RE = new RegExp(
  `\\b(?:(a|${Object.keys(WORD_VALUES).join("|")})[- ]?)?(${Object.keys(SCALE_WORDS).join("|")})\\b|\\b(${Object.keys(WORD_VALUES).join("|")})\\b`,
  "giu",
);

// "tripled", "doubling", "quadruples", "threefold": multipliers written as words.
const MULTIPLIER_WORDS = { doubl: 2, tripl: 3, quadrupl: 4 };
const MULTIPLIER_WORD_RE = /\b(doubled|doubles|doubling|double|tripled|triples|tripling|triple|quadrupled|quadruples|quadrupling|quadruple)\b/giu;
const FOLD_RE = new RegExp(`\\b(${Object.keys(WORD_VALUES).join("|")}|\\d+)[- ]?fold\\b`, "giu");

function kindOf(currency, unit) {
  if (currency) return "money";
  if (!unit) return "count";
  if (unit === "%" || unit.trim() === "percent") return "percent";
  return "multiplier";
}

/**
 * Find every number in `text`. Returns { value, kind, raw, index, plus }.
 * value is the normalized quantity; kind is count | percent | money | multiplier.
 */
export function findNumbers(text) {
  const found = [];
  for (const match of text.matchAll(DIGIT_RE)) {
    const [raw, currency, whole, decimal, suffix, plus, pctUnit, xUnit] = match;
    const unit = pctUnit ?? xUnit;
    let value = Number(`${whole.replace(/,/gu, "")}${decimal ? `.${decimal}` : ""}`);
    if (suffix) value *= SUFFIX_SCALE[suffix.toLowerCase()];
    found.push({ value, kind: kindOf(currency, unit?.toLowerCase()), raw: raw.trim(), index: match.index, plus: Boolean(plus) });
  }
  const digitSpans = found.map((n) => [n.index, n.index + n.raw.length]);
  for (const match of text.matchAll(WORD_RE)) {
    if (digitSpans.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const [raw, multiplierWord, scaleWord, loneWord] = match;
    let value;
    if (scaleWord) {
      const lead = !multiplierWord || multiplierWord.toLowerCase() === "a" ? 1 : WORD_VALUES[multiplierWord.toLowerCase()];
      value = lead * SCALE_WORDS[scaleWord.toLowerCase()];
    } else {
      value = WORD_VALUES[loneWord.toLowerCase()];
    }
    found.push({ value, kind: "count", raw: raw.trim(), index: match.index, plus: false, word: true });
  }
  for (const match of text.matchAll(MULTIPLIER_WORD_RE)) {
    const value = MULTIPLIER_WORDS[match[1].toLowerCase().replace(/(?:d|s|ing)$/u, "").replace(/e$/u, "")];
    if (value) found.push({ value, kind: "multiplier", raw: match[0], index: match.index, plus: false, word: true });
  }
  for (const match of text.matchAll(FOLD_RE)) {
    const n = WORD_VALUES[match[1].toLowerCase()] ?? Number(match[1]);
    if (n && !found.some((f) => f.index === match.index)) found.push({ value: n, kind: "multiplier", raw: match[0], index: match.index, plus: false, word: true });
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Same quantity, however it's written. Money and counts compare by value; percent only matches percent. */
export function sameNumber(a, b) {
  if (a.value !== b.value) return false;
  const pct = (n) => n.kind === "percent";
  return pct(a) === pct(b);
}

/**
 * Numbers worth tracing back to a source: anything with a unit (%, $, x, k, +),
 * or a count of 10 or more followed by a word. Skips years, dates, times,
 * list markers and small spelled-out numbers, which are almost never claims.
 */
export function claimNumbers(text) {
  return findNumbers(text).filter((n) => {
    if (n.word) return n.value >= 100;
    if (n.kind !== "count" || n.plus || /[kmb]/iu.test(n.raw)) return true;
    const before = text.slice(Math.max(0, n.index - 12), n.index);
    const after = text.slice(n.index + n.raw.length, n.index + n.raw.length + 24);
    // Bare 1900-2100 reads as a year; write "2,000 users" to have a count checked.
    if (/^\d{4}$/u.test(n.raw) && n.value >= 1900 && n.value <= 2100) return false;
    if (/^\s*(?:am|pm|:\d)/iu.test(after) || /[:/-]\s*$/u.test(before) || /^[/-]\d/u.test(after)) return false;
    const prevWord = before.trim().split(/\s+/u).pop()?.toLowerCase().replace(/[^a-z]/gu, "");
    if (prevWord && MONTHS.has(prevWord)) return false;
    if (/^\s*(?:st|nd|rd|th)\b/iu.test(after)) return false;
    return n.value >= 10 && /^\s*[a-z]/iu.test(after);
  });
}
