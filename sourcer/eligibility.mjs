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

  // stated graduation years always win over class-standing keywords
  if (years.has(TARGET)) return { eligibility: "explicit_2029", evidence: ev };
  if (range && range[0] <= TARGET && TARGET <= range[1]) return { eligibility: "range_includes_2029", evidence: ev };
  if (years.size) return { eligibility: "excludes_2029", evidence: ev };
  if (juniorOnly) return { eligibility: "excludes_2029", evidence: t.match(/.{0,80}\b(rising seniors?|penultimate year|juniors? only|final[- ]year students?)\b.{0,80}/i)?.[0] ?? "" };
  if (sophomore) return { eligibility: "explicit_2029", evidence: (t.match(/.{0,80}\b(freshm[ae]n|first[- ]year|sophomores?|second[- ]year|underclass\w*)\b.{0,80}/i)?.[0] || "").slice(0, 480) };
  return { eligibility: "unstated", evidence: "" };
}

const NON_US = /\b(china|shanghai|beijing|shenzhen|hong kong|taiwan|taipei|india|bangalore|bengaluru|hyderabad|pune|chennai|mumbai|delhi|gurgaon|noida|poland|gdansk|krakow|warsaw|united kingdom|uk|belgium|ghent|brussels|antwerp|austria|vienna|luxembourg|greece|athens|turkey|istanbul|ukraine|kyiv|serbia|belgrade|bulgaria|sofia|estonia|tallinn|lithuania|latvia|egypt|nigeria|kenya|south africa|new zealand|auckland|thailand|bangkok|indonesia|jakarta|pakistan|bangladesh|england|london|edinburgh|ireland|dublin|germany|berlin|munich|netherlands|amsterdam|france|paris|spain|madrid|barcelona|switzerland|zurich|geneva|singapore|japan|tokyo|korea|seoul|australia|sydney|melbourne|canada|toronto|vancouver|montreal|ontario|quebec|israel|tel aviv|brazil|sao paulo|mexico|romania|czech|prague|hungary|budapest|sweden|stockholm|denmark|copenhagen|finland|norway|italy|milan|portugal|lisbon|uae|dubai|vietnam|philippines|malaysia|costa rica|argentina|colombia|chile|emea|apac)\b/i;
const US_WORDS = /\b(united states|usa|u\.s\.a?|new york|nyc|san francisco|seattle|chicago|boston|austin|los angeles|denver|atlanta|miami|dallas|houston|philadelphia|pittsburgh|mclean|santa clara|san jose|mountain view|palo alto|menlo park|sunnyvale|redmond|bellevue|bay area)\b/i;
const US_CODE = /(^|[\s,(;-])(US|AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)([\s,);-]|$)/;

/** true if the location is (or may be) in the US. Unknown / multi-location / plain "Remote" → kept. */
export function usOk(loc) {
  if (!loc) return true;
  const strongUS = US_WORDS.test(loc) || US_CODE.test(loc);
  if (NON_US.test(loc) && !strongUS) return false;
  return true;
}
