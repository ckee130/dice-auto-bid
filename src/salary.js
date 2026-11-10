/**
 * Pay extraction from a job description.
 *
 * A plain-JavaScript port of src/lib/salary.ts from the Resume Builder app.
 * Copied rather than imported on purpose: this extension has to run on a
 * machine that has never seen the app, so a shared module would be a
 * dependency it cannot satisfy. Any fix to one belongs in the other.
 *
 * The hard part is not finding money, it is ignoring it. Postings are full of
 * figures that look like pay and are not: funding rounds, ARR, cost savings the
 * team delivered, 401(k), years of experience, team sizes. So every candidate
 * must be anchored (a currency symbol, a trailing currency code, or a pay word
 * just before it), must survive a context check for funding and revenue
 * language, and must land inside a plausible range for the period it claims.
 *
 * Missing a stated salary is cheap; asking for $10k because the posting
 * mentioned a seed round is not.
 */

/** Plausible pay by period. Anything outside is some other number. */
const BOUNDS = {
  year: { min: 20000, max: 2000000 },
  month: { min: 1500, max: 200000 },
  week: { min: 400, max: 50000 },
  day: { min: 80, max: 10000 },
  hour: { min: 10, max: 2000 },
};

const PERIOD_LABELS = { year: "yr", month: "mo", week: "wk", day: "day", hour: "hr" };

const SYMBOLS = { $: "$", "US$": "$", "C$": "C$", "CA$": "C$", "A$": "A$", "£": "£", "€": "€", "₹": "₹" };

const CODES = { USD: "$", CAD: "C$", AUD: "A$", GBP: "£", EUR: "€", INR: "₹" };

const PAY_WORDS =
  /\b(?:salary|salaries|compensation|comp\b|base pay|base salary|pay range|pay rate|pay scale|paying|pays|rate of pay|hourly rate|wage|wages|remuneration|earnings|OTE|on[- ]target|total comp|we offer|range for this|budgeted (?:range|salary))/i;

/** Language that marks a figure as company money rather than the reader's. */
const NOT_PAY_WORDS =
  /\b(?:raised|raising|funding|funded|seed round|series [a-f]\b|valuation|valued at|ARR|MRR|revenue|GMV|market cap|in sales|bookings|saved|savings|cost reduction|reduced costs|assets under management|transaction volume|processed|portfolio|contract value|grant|fundraise)\b/i;

const PERIOD_PATTERNS = [
  { pattern: /\b(?:per\s+hour|an?\s+hour|hourly|\/\s*hour|\/\s*hr\b|per\s+hr\b)/i, period: "hour" },
  { pattern: /\b(?:per\s+day|a\s+day|daily|\/\s*day|per\s+diem)/i, period: "day" },
  { pattern: /\b(?:per\s+week|a\s+week|weekly|\/\s*week|\/\s*wk\b)/i, period: "week" },
  { pattern: /\b(?:per\s+month|a\s+month|monthly|\/\s*month|\/\s*mo\b)/i, period: "month" },
  { pattern: /\b(?:per\s+year|per\s+annum|a\s+year|annually|annual|yearly|\/\s*year|\/\s*yr\b|p\.?a\.?\b)/i, period: "year" },
];

const AMOUNT_PATTERN =
  /(US\$|CA\$|C\$|A\$|[$£€₹])?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d+)?)\s*([kKmMbB])?/g;

function scanAmounts(jd) {
  const amounts = [];
  AMOUNT_PATTERN.lastIndex = 0;

  for (let match = AMOUNT_PATTERN.exec(jd); match; match = AMOUNT_PATTERN.exec(jd)) {
    const [raw, symbol, digits, suffix] = match;
    const start = match.index + (raw.length - raw.trimStart().length);

    // A retirement plan is not a pay figure, and "401" sits inside the hourly band.
    if (/401\s*\(?k/i.test(jd.slice(Math.max(0, start - 4), start + 8))) continue;
    // Part of a decimal, a version number or an identifier rather than money.
    if (start > 0 && /[\d.\-/\w]/.test(jd[start - 1]) && !symbol) continue;

    const base = Number.parseFloat(digits.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;

    const lower = suffix ? suffix.toLowerCase() : undefined;
    amounts.push({
      value: lower === "k" ? base * 1000 : base,
      start,
      end: match.index + raw.length,
      symbol: symbol ? SYMBOLS[symbol] ?? "$" : null,
      oversized: lower === "m" || lower === "b",
    });
  }

  return amounts;
}

function periodNear(jd, end, fallbackStart) {
  // Look after the figure first, where the unit almost always sits, then before
  // it for phrasings like "an annual salary of 150,000".
  const after = jd.slice(end, end + 40);
  const before = jd.slice(Math.max(0, fallbackStart - 45), fallbackStart);

  for (const window of [after, before]) {
    for (const { pattern, period } of PERIOD_PATTERNS) {
      if (pattern.test(window)) return period;
    }
  }
  return null;
}

function currencyNear(jd, amount, end) {
  if (amount.symbol) return amount.symbol;
  const code = jd.slice(end, end + 12).match(/^\s*\b(USD|CAD|AUD|GBP|EUR|INR)\b/i);
  if (code) return CODES[code[1].toUpperCase()];
  const leading = jd.slice(Math.max(0, amount.start - 12), amount.start).match(/\b(USD|CAD|AUD|GBP|EUR|INR)\b\s*$/i);
  return leading ? CODES[leading[1].toUpperCase()] : null;
}

function formatAmount(value, currency) {
  if (value >= 10000) {
    const thousands = value / 1000;
    const rounded = thousands % 1 === 0 ? String(thousands) : thousands.toFixed(1).replace(/\.0$/, "");
    return `${currency}${rounded}k`;
  }
  return `${currency}${value % 1 === 0 ? value.toLocaleString("en-US") : value.toFixed(2)}`;
}

/**
 * Reads the advertised pay out of a posting, or null when nothing is stated.
 * Ranges, single figures and open-ended phrasing are all recognised.
 */
export function parseSalary(jd) {
  if (!jd || !jd.trim()) return null;

  const amounts = scanAmounts(jd);
  const candidates = [];

  for (let index = 0; index < amounts.length; index += 1) {
    const amount = amounts[index];
    if (amount.oversized) continue;

    // A range is two figures joined by nothing but a dash or "to".
    const next = amounts[index + 1];
    const joiner = next ? jd.slice(amount.end, next.start) : "";
    const isRange = Boolean(next) && !next.oversized && /^\s*(?:-|–|—|to|up to|through)\s*$/i.test(joiner);
    const high = isRange ? next : amount;

    const before = jd.slice(Math.max(0, amount.start - 70), amount.start);
    const context = `${jd.slice(Math.max(0, amount.start - 100), amount.start)} ${jd.slice(high.end, high.end + 40)}`;

    const paid = PAY_WORDS.test(before);
    const currency = currencyNear(jd, amount, high.end) ?? (isRange ? currencyNear(jd, next, next.end) : null);
    if (!currency && !paid) continue;
    if (NOT_PAY_WORDS.test(context) && !paid) continue;

    // A bare year reads as money only when something marks it as money.
    if (!currency && !isRange && amount.value >= 1900 && amount.value <= 2100 && Number.isInteger(amount.value)) {
      continue;
    }

    const stated = periodNear(jd, high.end, amount.start);
    // A number with neither a currency nor a unit is not pay, however suggestive
    // the surrounding words are. Postings are full of bare counts that sit in
    // the hourly band: H1B sponsorships granted, headcount, applicants.
    if (!currency && !stated) continue;

    // Without a stated unit, magnitude is the only signal: four figures and up
    // is annual, anything smaller is a rate.
    const period = stated ?? (amount.value >= 1000 ? "year" : "hour");

    const bounds = BOUNDS[period];
    if (amount.value < bounds.min || high.value > bounds.max) continue;
    if (isRange && next.value < amount.value) continue;

    const openMatch = (before.match(/\b(up to|starting at|starting from|from|at least|minimum of)\s*$/i) || [])[1];
    const open = openMatch ? (/^up to$/i.test(openMatch) ? "below" : "above") : null;

    const symbol = currency ?? "";
    const label = isRange
      ? `${formatAmount(amount.value, symbol)} - ${formatAmount(high.value, symbol)}`
      : formatAmount(amount.value, symbol);

    candidates.push({
      min: amount.value,
      max: high.value,
      currency: symbol,
      period,
      open: isRange ? null : open,
      text: `${open === "below" && !isRange ? "up to " : ""}${label}/${PERIOD_LABELS[period]}`,
      source: jd.slice(amount.start, high.end).replace(/\s+/g, " ").trim(),
      score: (paid ? 3 : 0) + (stated ? 2 : 0) + (isRange ? 2 : 0) + (currency ? 1 : 0),
      index: amount.start,
    });

    if (isRange) index += 1;
  }

  if (candidates.length === 0) return null;

  // Best evidence wins; the earliest mention breaks ties, since postings state
  // the real range once and then reference it loosely.
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  const { score, index, ...best } = candidates[0];
  return best;
}

/** Annualises a rate so a number asked for in a form is comparable. */
function perYear(value, period) {
  if (period === "year") return value;
  if (period === "month") return value * 12;
  if (period === "week") return value * 52;
  if (period === "day") return value * 260;
  return value * 2080;
}

/**
 * The figure to type into a "desired salary" box.
 *
 * The midpoint of whatever the posting states, because asking at the top of a
 * published band reads as not having read it, and asking below the floor is a
 * discount nobody asked for. When the posting states nothing there is nothing
 * to anchor to, so the configured fallback stands in.
 */
export function desiredSalary(jd, fallbackPerYear) {
  const stated = parseSalary(jd);
  if (!stated) return { amount: Math.round(fallbackPerYear), from: "fallback" };

  const low = perYear(stated.min, stated.period);
  const high = perYear(stated.max, stated.period);

  // "Up to 180k" has no floor to average against, so the stated end is the
  // only honest anchor.
  const midpoint = stated.open === "below" ? high : stated.open === "above" ? low : (low + high) / 2;

  return { amount: Math.round(midpoint), from: "posting", stated: stated.text };
}
