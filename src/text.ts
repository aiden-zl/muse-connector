// Pure text helpers: question normalization, answer matching, scrubbing, PII rejection, danger flags.
import { normText } from "./keys";

export { normText };

/** Kinds whose answers are specific to one job/lease: never deduped, never banked. */
export const JOB_SPECIFIC_KINDS = new Set(["verification_code", "approval"]);
export const QUESTION_KINDS = ["choice", "freeform", "essay", "approval", "verification_code", "other"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export interface BankEntry {
  id: number;
  norm: string;
  question: string;
  answer: string;
  keywords: string | null;
}

/** Find the best answer-bank entry for a question. Exact normalized match wins; else all-keywords match. */
export function matchAnswer(question: string, bank: BankEntry[]): BankEntry | null {
  const n = normText(question);
  if (!n) return null;
  const exact = bank.find((b) => b.norm === n);
  if (exact) return exact;
  const words = new Set(n.split(" "));
  let best: BankEntry | null = null;
  let bestScore = 0;
  for (const b of bank) {
    if (!b.keywords) continue;
    const kws = b.keywords.split(",").map((k) => normText(k)).filter(Boolean);
    if (!kws.length) continue;
    const ok = kws.every((k) => (k.includes(" ") ? n.includes(k) : words.has(k)));
    if (ok && kws.length > bestScore) {
      best = b;
      bestScore = kws.length;
    }
  }
  return best;
}

/** Remove things that look like verification codes / secrets from free text before logging. */
export function scrub(s: string | null | undefined, max = 1000): string | null {
  if (s == null) return null;
  return String(s)
    .replace(/\b\d{4,8}\b/g, "[digits]")
    .replace(/\b[A-Za-z0-9_.!@#-]{16,}\b/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? "[redacted]" : m))
    .slice(0, max);
}

function luhn(d: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Returns a reason string if the text contains data the bridge must never store. */
export function forbiddenPii(s: string): string | null {
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(s)) return "looks like an SSN";
  if (/\b(ssn|social security)\b/i.test(s) && /\b\d{9}\b/.test(s)) return "looks like an SSN";
  for (const m of s.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "looks like a card number";
  }
  if (/\b(date of birth|dob|birth ?date)\b/i.test(s) && /\b\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b/.test(s)) return "looks like a date of birth";
  if (/\b(routing|account) (number|no)\b/i.test(s) && /\b\d{6,17}\b/.test(s)) return "looks like bank details";
  return null;
}

const DANGER: [RegExp, string][] = [
  [/\b(fee|payment|pay|purchase|buy|credit card|debit card|invoice|deposit)\b/i, "money"],
  [/\b(gift ?cards?|crypto|bitcoin|usdt|wire transfer|zelle|cash ?app|venmo|check)\b/i, "money"],
  [/\b(ssn|social security|national id|passport|driver'?s licen[cs]e|id scan|photo id)\b/i, "identity_document"],
  [/\b(bank|routing number|account number|iban)\b/i, "bank"],
  [/\b(gmail|google|outlook|hotmail|yahoo|icloud|meta|facebook|instagram|whatsapp|linkedin)\b.*\b(password|code|login|sign ?in|2fa|otp)\b/i, "personal_account_access"],
  [/\b(2fa|two.factor|authenticator|backup code|recovery code)\b/i, "personal_account_access"],
  [/\b(anydesk|teamviewer|remote access|remote desktop|install (this|the) (app|software)|download (this|the) (app|software))\b/i, "remote_access"],
  [/\b(telegram|signal app|whatsapp interview|text interview)\b/i, "scam_channel"],
  [/\b(offer without interview|no interview|hired immediately|equipment)\b/i, "scam_pattern"],
];

/** Tags that tell the guardian a question needs extra care. */
export function dangerFlags(...texts: (string | null | undefined)[]): string[] {
  const t = texts.filter(Boolean).join("\n");
  const out = new Set<string>();
  for (const [re, tag] of DANGER) if (re.test(t)) out.add(tag);
  return [...out];
}

export function clip(s: unknown, max: number): string | null {
  if (s == null) return null;
  const str = String(s);
  return str.length > max ? str.slice(0, max) + "…" : str;
}
