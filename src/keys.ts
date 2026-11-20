// Pure helpers: job dedupe keys, account-scope site keys, soft (fuzzy) duplicate keys.

export type Ats = "greenhouse" | "lever" | "ashby" | "workday" | "smartrecruiters" | "other";

export interface JobKeys {
  ats: Ats;
  dedupe_key: string;
  site_key: string;
}

const TRACKING_PARAMS = /^(utm_|gh_src|source|src|ref|lever-|lever_|iis|iisn|trk|mode)/i;

function seg(u: URL): string[] {
  return u.pathname.split("/").filter(Boolean);
}

/** Parse a job URL into its ATS, a stable dedupe key, and the account-scope site key. Throws on invalid URL. */
export function jobKeys(rawUrl: string): JobKeys {
  const u = new URL(rawUrl.trim());
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("job url must be http(s)");
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = seg(u);

  // Greenhouse (hosted boards, embed, or gh_jid on a company careers page)
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io" || host.endsWith(".greenhouse.io")) {
    const embedFor = u.searchParams.get("for");
    const embedToken = u.searchParams.get("token");
    if (embedFor && embedToken) {
      const b = embedFor.toLowerCase();
      return { ats: "greenhouse", dedupe_key: `gh:${b}:${embedToken}`, site_key: `gh:${b}` };
    }
    const jobsIdx = parts.indexOf("jobs");
    if (jobsIdx >= 1 && parts[jobsIdx + 1]) {
      const b = parts[jobsIdx - 1].toLowerCase();
      const id = parts[jobsIdx + 1];
      return { ats: "greenhouse", dedupe_key: `gh:${b}:${id}`, site_key: `gh:${b}` };
    }
  }
  const ghJid = u.searchParams.get("gh_jid");
  if (ghJid && /^\d+$/.test(ghJid)) {
    return { ats: "greenhouse", dedupe_key: `gh:${host}:${ghJid}`, site_key: `gh:${host}` };
  }

  // Lever
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    if (parts.length >= 2) {
      const co = parts[0].toLowerCase();
      const id = parts[1].toLowerCase();
      return { ats: "lever", dedupe_key: `lever:${co}:${id}`, site_key: `lever:${co}` };
    }
  }

  // Ashby
  if (host === "jobs.ashbyhq.com") {
    if (parts.length >= 2) {
      const co = parts[0].toLowerCase();
      const id = parts[1].toLowerCase();
      return { ats: "ashby", dedupe_key: `ashby:${co}:${id}`, site_key: `ashby:${co}` };
    }
  }

  // Workday: {tenant}.wdN.myworkdayjobs.com/[locale/]{site}/job/{location}/{slug}_{REQ}[/apply...]
  const wd = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/) ?? host.match(/^([a-z0-9-]+)\.myworkdayjobs\.com$/);
  if (wd) {
    const tenant = wd[1];
    const jobIdx = parts.indexOf("job");
    let req: string | undefined;
    if (jobIdx >= 0) {
      // the slug segment is the last one after "job" that contains an underscore-delimited req id
      const after = parts.slice(jobIdx + 1).filter((p) => !/^apply/i.test(p) && !/^(autofillWithResume|applyManually|useMyLastApplication)$/i.test(p));
      for (let i = after.length - 1; i >= 0; i--) {
        const m = after[i].match(/_([A-Za-z]*-?\d[\w-]*)$/);
        if (m) { req = m[1].toLowerCase(); break; }
      }
    }
    if (req) return { ats: "workday", dedupe_key: `wd:${tenant}:${req}`, site_key: `wd:${tenant}` };
    return { ats: "workday", dedupe_key: `url:${host}${cleanPath(u.pathname)}`, site_key: `wd:${tenant}` };
  }

  // SmartRecruiters: jobs.smartrecruiters.com/{co}/{id}-{slug}
  if (host === "jobs.smartrecruiters.com" && parts.length >= 2) {
    const co = parts[0].toLowerCase();
    const id = parts[1].match(/^(\d+)/)?.[1];
    if (id) return { ats: "smartrecruiters", dedupe_key: `sr:${co}:${id}`, site_key: `sr:${co}` };
  }

  // Fallback: host + path (path case preserved) + non-tracking params that look like ids.
  const keep: string[] = [];
  for (const [k, v] of [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (TRACKING_PARAMS.test(k)) continue;
    if (/(^|_)(id|jid|job|jobid|req|reqid|posting|pid)$/i.test(k)) keep.push(`${k.toLowerCase()}=${v}`);
  }
  const q = keep.length ? `?${keep.join("&")}` : "";
  return { ats: "other", dedupe_key: `url:${host}${cleanPath(u.pathname)}${q}`, site_key: host };
}

function cleanPath(p: string): string {
  let out = p.replace(/\/+$/, "");
  out = out.replace(/\/(apply|application)$/i, "");
  return out || "/";
}

export function normText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const COMPANY_SUFFIX = /\b(inc|llc|ltd|corp|corporation|co|company|group|holdings|technologies|technology|labs)\b/g;

export function normCompany(s: string): string {
  return normText(s).replace(COMPANY_SUFFIX, "").replace(/\s+/g, " ").trim();
}

/** Fuzzy key used to flag the same internship posted on two URLs. */
export function softKey(company: string, title: string): string {
  const t = normText(title);
  const season = t.match(/\b(summer|fall|winter|spring)\s*(20\d\d)\b/);
  const year = season ? `${season[1]}${season[2]}` : (t.match(/\b20\d\d\b/)?.[0] ?? "");
  const core = t
    .replace(/\b(summer|fall|winter|spring)\b/g, "")
    .replace(/\b20\d\d\b/g, "")
    .replace(/\b(the|a|an|and|of|for|in|at|to|program|position|role|opening)\b/g, "")
    .replace(/\binternship\b/g, "intern")
    .replace(/\b(swe|sde|software development engineer|software engineering|software developer)\b/g, "software engineer")
    .replace(/\bquantitative\b/g, "quant")
    .replace(/\bml\b/g, "machine learning")
    .replace(/\b(co op|coop)\b/g, "intern")
    .replace(/\s+/g, " ")
    .trim();
  return `${normCompany(company)}|${core}|${year}`;
}

/** Safe for `security -i` line tokenizer (validated in review): */
export const SITE_KEY_RE = /^[a-z0-9:._/%-]{1,200}$/;
export const EMAIL_RE = /^[A-Za-z0-9._%+@-]{1,254}$/;

/** Map an arbitrary site_key into the Keychain-safe charset (lowercase, replace others with '%'). */
export function keychainSafeSiteKey(siteKey: string): string {
  return siteKey.toLowerCase().replace(/[^a-z0-9:._/%-]/g, "%").slice(0, 200);
}
