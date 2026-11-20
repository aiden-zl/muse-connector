#!/usr/bin/env node
// Job sourcer: pulls public Greenhouse / Lever / Ashby job boards, keeps SWE/quant internships that a
// class-of-2029 student can apply to, and writes a bridge-ready CSV (default 300 rows).
// Usage: node sourcer/source.mjs [--out batches/batch-001.csv] [--limit 300] [--companies sourcer/companies.json]
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { jobKeys, softKey } from "../src/keys.ts";
import { classify } from "./eligibility.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const LIMIT = Number(args.limit ?? 300);
const INCLUDE_NON_US = process.argv.includes("--include-non-us");
const companies = JSON.parse(readFileSync(args.companies ?? join(here, "companies.json"), "utf8"));
const batchesDir = join(here, "..", "batches");
const OUT = args.out ?? nextBatchName();

function nextBatchName() {
  const n = readdirSync(batchesDir).filter((f) => /^batch-\d+\.csv$/.test(f)).length + 1;
  return join(batchesDir, `batch-${String(n).padStart(3, "0")}.csv`);
}

const TITLE_INTERN = /\b(intern|interns|internship|co-?op|summer analyst|summer associate)\b/i;
const TITLE_FIELD = /\b(software|engineer|engineering|developer|swe|quant|quantitative|trading|trader|research|data|machine learning|ml|ai|infrastructure|backend|back-end|frontend|front-end|full[- ]stack|platform|security|systems|mobile|ios|android|devops|sre|algorithm)/i;
const TITLE_EXCLUDE = /\b(electrical|mechanical|civil|chemical|manufacturing|hardware|asic|rtl|analog|rf|process engineer|industrial|supply chain|facilities|construction|environmental|biomedical|clinical|phd|ph\.d|doctoral|mba|master'?s|postdoc|new grad|full[- ]time|senior|staff|principal|manager|director|recruit|sales|marketing|legal|finance intern|accounting|hr |people|design intern|summer 2026|fall 2026|2026 intern)\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "job-sourcer/1.0", Accept: "application/json" } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(String(r.status));
      return await r.json();
    } catch (e) {
      if (i === 1) return null;
      await sleep(500);
    }
  }
  return null;
}

const strip = (html) =>
  String(html ?? "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

async function greenhouse(token) {
  const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`);
  if (!d?.jobs) return null;
  const name = d.jobs[0]?.company_name ?? token;
  return d.jobs.map((j) => ({ company: j.company_name ?? name, title: j.title, url: j.absolute_url, location: j.location?.name ?? "", text: strip(j.content) }));
}

async function lever(token) {
  const d = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`);
  if (!Array.isArray(d)) return null;
  return d.map((j) => ({
    company: token,
    title: j.text,
    url: j.hostedUrl,
    location: j.categories?.location ?? "",
    text: [j.descriptionPlain, ...(j.lists ?? []).map((l) => `${l.text} ${strip(l.content)}`), j.additionalPlain].join(" "),
  }));
}

async function ashby(token) {
  const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`);
  if (!d?.jobs) return null;
  return d.jobs.filter((j) => j.isListed !== false).map((j) => ({ company: token, title: j.title, url: j.jobUrl, location: j.location ?? "", text: j.descriptionPlain ?? strip(j.descriptionHtml) }));
}

async function postJson(url, body) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * 2 ** i); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch {
      await sleep(1000);
    }
  }
  return null;
}

async function getJsonRetry(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * 2 ** i); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch {
      await sleep(1000);
    }
  }
  return null;
}

// Workday CXS API: "tenant/wdN/site"
async function workday(spec) {
  const [tenant, wd, site] = spec.split("/");
  const base = `https://${tenant}.${wd}.myworkdayjobs.com`;
  const api = `${base}/wday/cxs/${tenant}/${site}`;
  const seen = new Map();
  for (let offset = 0; offset < 200; offset += 20) {
    const d = await postJson(`${api}/jobs`, { appliedFacets: {}, limit: 20, offset, searchText: "intern" });
    if (!d) { if (offset === 0) return null; break; }
    for (const j of d.jobPostings ?? []) if (j.externalPath && !seen.has(j.externalPath)) seen.set(j.externalPath, j);
    if (!d.jobPostings?.length || offset + 20 >= (d.total ?? 0)) break;
    await sleep(400);
  }
  const out = [];
  for (const j of seen.values()) {
    if (!TITLE_INTERN.test(j.title) || !TITLE_FIELD.test(j.title) || TITLE_EXCLUDE.test(j.title)) continue;
    await sleep(300);
    const det = await getJsonRetry(`${api}${j.externalPath}`);
    const info = det?.jobPostingInfo ?? {};
    out.push({
      company: det?.hiringOrganization?.name ?? tenant,
      title: j.title,
      url: info.externalUrl ?? `${base}/${site}${j.externalPath}`,
      location: [info.location, ...(info.additionalLocations ?? [])].filter(Boolean).join("; ") || j.locationsText || "",
      text: strip(info.jobDescription),
    });
  }
  return out;
}

const NON_US = /\b(china|shanghai|beijing|shenzhen|hong kong|taiwan|taipei|india|bangalore|bengaluru|hyderabad|pune|chennai|mumbai|delhi|gurgaon|noida|poland|gdansk|krakow|warsaw|united kingdom|uk|england|london|cambridge, uk|edinburgh|ireland|dublin|germany|berlin|munich|netherlands|amsterdam|france|paris|spain|madrid|barcelona|switzerland|zurich|geneva|singapore|japan|tokyo|korea|seoul|australia|sydney|melbourne|canada|toronto|vancouver|montreal|ontario|quebec|israel|tel aviv|brazil|sao paulo|mexico|romania|czech|prague|hungary|budapest|sweden|stockholm|denmark|copenhagen|finland|norway|italy|milan|portugal|lisbon|uae|dubai|vietnam|philippines|malaysia|costa rica|argentina|colombia|chile)\b/i;
const US = /\b(united states|usa|u\.s\.|us|remote|new york|nyc|san francisco|seattle|chicago|boston|austin|los angeles|denver|atlanta|miami|dallas|houston|philadelphia|pittsburgh|washington|mclean|santa clara|san jose|mountain view|palo alto|menlo park|sunnyvale|redmond|bellevue|cambridge, ma|[A-Z]{2}\b)/;
function usOk(loc) {
  if (!loc || /\d+ locations?/i.test(loc)) return true;
  if (US.test(loc)) return true;
  return !NON_US.test(loc);
}

const prettyCompany = (s) => (/[A-Z ]/.test(s) ? s : s.replace(/(^|-)([a-z])/g, (_, a, b) => (a ? " " : "") + b.toUpperCase()));

function knownKeys() {
  const dedupe = new Set();
  const soft = new Set();
  // keys from earlier local batches
  for (const f of readdirSync(batchesDir).filter((f) => /^batch-\d+\.csv$/.test(f))) {
    for (const line of readFileSync(join(batchesDir, f), "utf8").split("\n").slice(1)) {
      const url = line.match(/^"?(https?:[^",]+)/)?.[1];
      if (url) try { dedupe.add(jobKeys(url).dedupe_key); } catch {}
    }
  }
  // keys already in the bridge (if configured)
  try {
    const out = execFileSync("node", [join(here, "..", "guardian", "cli.mjs"), "job-keys"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const k of JSON.parse(out)) { dedupe.add(k.dedupe_key); soft.add(k.soft_key); }
  } catch {}
  return { dedupe, soft };
}

const csvCell = (v) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const known = knownKeys();
  const sources = [
    ...companies.greenhouse.map((t) => ["greenhouse", t, greenhouse]),
    ...companies.lever.map((t) => ["lever", t, lever]),
    ...companies.ashby.map((t) => ["ashby", t, ashby]),
  ];
  const wdSources = (companies.workday ?? []).map((t) => ["workday", t, workday]);
  const missing = [];
  const candidates = [];
  const stats = { boards_ok: 0, postings: 0, intern_titles: 0, excluded_grad_year: 0, duplicates: 0 };
  // modest concurrency, polite
  const chunks = [];
  for (let i = 0; i < sources.length; i += 6) chunks.push(sources.slice(i, i + 6));
  for (const w of wdSources) chunks.push([w]); // Workday rate-limits: one tenant at a time
  for (const chunk of chunks) {
    const res = await Promise.all(chunk.map(([ats, t, fn]) => fn(t).then((r) => [ats, t, r])));
    for (const [ats, t, jobs] of res) {
      if (!jobs) { missing.push(`${ats}:${t}`); continue; }
      stats.boards_ok++;
      stats.postings += jobs.length;
      for (const j of jobs) {
        if (!j.url || !j.title) continue;
        if (!TITLE_INTERN.test(j.title) || !TITLE_FIELD.test(j.title) || TITLE_EXCLUDE.test(j.title)) continue;
        if (!INCLUDE_NON_US && !usOk(j.location)) { stats.non_us = (stats.non_us ?? 0) + 1; continue; }
        stats.intern_titles++;
        const e = classify(j.title, j.text);
        if (e.eligibility === "excludes_2029") { stats.excluded_grad_year++; continue; }
        let keys;
        try { keys = jobKeys(j.url); } catch { continue; }
        const company = prettyCompany(String(j.company).trim());
        const sk = softKey(company, j.title);
        if (known.dedupe.has(keys.dedupe_key) || known.soft.has(sk)) { stats.duplicates++; continue; }
        known.dedupe.add(keys.dedupe_key);
        known.soft.add(sk);
        const quant = /\b(quant|quantitative|trading|trader)\b/i.test(j.title);
        candidates.push({
          url: j.url,
          company,
          title: j.title.trim(),
          location: j.location,
          deadline: "",
          eligibility: e.eligibility,
          grad_year_evidence: e.evidence,
          priority: (e.eligibility === "explicit_2029" ? 20 : e.eligibility === "range_includes_2029" ? 15 : 0) + (quant ? 2 : 0),
        });
      }
    }
    await sleep(200);
  }
  candidates.sort((a, b) => b.priority - a.priority);
  const rows = candidates.slice(0, LIMIT);
  const cols = ["url", "company", "title", "location", "deadline", "eligibility", "grad_year_evidence", "priority"];
  writeFileSync(OUT, [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n");
  const byElig = rows.reduce((m, r) => ((m[r.eligibility] = (m[r.eligibility] ?? 0) + 1), m), {});
  console.log(JSON.stringify({ out: OUT, rows: rows.length, available: candidates.length, by_eligibility: byElig, ...stats, boards_missing: missing.length, missing_boards: missing }, null, 2));
}

await main();
