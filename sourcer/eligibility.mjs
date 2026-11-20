// Decide whether a class-of-2029 student can apply, from posting text. Conservative: only drop a posting when
// the text clearly excludes 2029; otherwise keep it and record the evidence.
export const TARGET = 2029;

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|spring|summer|fall|winter|autumn)";

export function classify(title, text) {
  const t = `${title}\n${text ?? ""}`.replace(/\s+/g, " ");
  const evidence = [];
  const years = new Set();
  let range = null;

  // windows around graduation language
  const re = /(graduat\w*|class of|grad date|degree completion|completing (?:your|their|a) degree)/gi;
  let m;
  while ((m = re.exec(t))) {
    const raw = t.slice(Math.max(0, m.index - 40), m.index + 160);
    // drop program-season years ("Summer 2027 internship") unless they directly follow graduation wording
    const win = raw.replace(/(summer|fall|winter|spring|autumn)\s+(20[2-3]\d)/gi, (mm, _s, _y, off) =>
      /graduat\w*\s*(?:in|by|date(?: of)?)?\s*$/i.test(raw.slice(Math.max(0, off - 30), off)) ? mm : _s);
    const ys = [...win.matchAll(/\b(20[2-3]\d)\b/g)].map((x) => Number(x[1])).filter((y) => y >= 2025 && y <= 2033);
    if (!ys.length) continue;
    evidence.push(win.trim());
    ys.forEach((y) => years.add(y));
    const r = win.match(new RegExp(`(?:between|from)?\\s*(?:${MONTH}\\s*)?(20[2-3]\\d)\\s*(?:and|-|–|to|through)\\s*(?:${MONTH}\\s*)?(20[2-3]\\d)`, "i"));
    if (r) {
      const a = Number(r[1]), b = Number(r[2]);
      range = [Math.min(a, b, range?.[0] ?? 9999), Math.max(a, b, range?.[1] ?? 0)];
    }
    if (/\b(20[2-3]\d)\s*(?:or later|and later|or after|\+|onward)/i.test(win)) {
      const y = Number(win.match(/\b(20[2-3]\d)\s*(?:or later|and later|or after|\+|onward)/i)[1]);
      if (y <= TARGET) range = [y, 9999];
    }
    if (evidence.length >= 3) break;
  }

  const sophomore = /\b(freshm[ae]n|first[- ]year|sophomores?|second[- ]year|underclass(?:men)?|early[- ]career program for (?:first|second))\b/i.test(t);
  const juniorOnly = /\b(rising seniors?|penultimate year|juniors? only|final[- ]year students?)\b/i.test(t) && !sophomore;
  const ev = evidence.join(" … ").slice(0, 480);

  if (years.has(TARGET)) return { eligibility: "explicit_2029", evidence: ev };
  if (range && range[0] <= TARGET && TARGET <= range[1]) return { eligibility: "range_includes_2029", evidence: ev };
  if (sophomore) return { eligibility: "explicit_2029", evidence: (ev || t.match(/.{0,80}\b(freshm[ae]n|first[- ]year|sophomores?|second[- ]year|underclass\w*)\b.{0,80}/i)?.[0] || "").slice(0, 480) };
  if (years.size) {
    // explicit years given and 2029 not among them / not in range → excluded
    return { eligibility: "excludes_2029", evidence: ev };
  }
  if (juniorOnly) return { eligibility: "excludes_2029", evidence: t.match(/.{0,80}\b(rising seniors?|penultimate year|juniors? only|final[- ]year students?)\b.{0,80}/i)?.[0] ?? "" };
  return { eligibility: "unstated", evidence: "" };
}
