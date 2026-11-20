// Guardian-only REST API. Bearer ADMIN_TOKEN in the Authorization header. No CORS: browsers never call this.
import type { Env } from "./env";
import { ctEqual } from "./crypto";
import { bump, peek } from "./auth";
import { jobKeys, normCompany, normText, softKey } from "./keys";
import { forbiddenPii, JOB_SPECIFIC_KINDS } from "./text";
import { decryptSecret, importCredKey } from "./crypto";
import { getConfig, housekeeping, logEvent, progress, promoteStmt, type JobRow } from "./queue";

const MIN = 60_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const CONFIG_KEYS = new Set([
  "paused",
  "lease_minutes",
  "submit_extend_minutes",
  "max_attempts",
  "max_expired_leases",
  "max_answer_polls",
  "code_wait_s",
  "waiting_timeout_hours",
  "batch_low_threshold",
  "batch_low_flagged",
  "credential_creates_per_hour",
]);

const JOB_STATUSES = new Set(["pending", "ready", "skipped", "submitted", "needs_human"]);
const ELIGIBILITY = new Set(["explicit_2029", "range_includes_2029", "unstated"]);

async function authorized(req: Request, env: Env): Promise<Response | null> {
  if ((await peek(env.DB, "admin_fail", 60 * MIN)) >= 30) return json({ error: "locked" }, 429);
  const h = req.headers.get("Authorization") ?? "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!env.ADMIN_TOKEN || !tok || !(await ctEqual(tok, env.ADMIN_TOKEN))) {
    await bump(env.DB, "admin_fail", 60 * MIN);
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

export async function handleAdmin(req: Request, env: Env): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 405 });
  const denied = await authorized(req, env);
  if (denied) return denied;
  const db = env.DB;
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const m = req.method;
  const body = async () => {
    try {
      return (await req.json()) as any;
    } catch {
      return {};
    }
  };

  // ---- jobs
  if (path === "/admin/jobs" && m === "POST") {
    const b = await body();
    const list: any[] = Array.isArray(b) ? b : Array.isArray(b.jobs) ? b.jobs : [];
    if (!list.length) return json({ error: "no jobs" }, 400);
    if (list.length > 1000) return json({ error: "max 1000 per call" }, 400);
    const t = Date.now();
    const batch = await db.prepare("INSERT INTO batches (created_at, size, source_note) VALUES (?, ?, ?) RETURNING id").bind(t, list.length, String(b.source_note ?? "")).first<{ id: number }>();
    const errors: { index: number; error: string }[] = [];
    const rows: any[] = [];
    list.forEach((j, index) => {
      try {
        if (!j || !j.url || !j.company || !j.title) throw new Error("url, company, title required");
        const elig = String(j.eligibility ?? "unstated");
        if (elig === "excludes_2029") throw new Error("excludes 2029 grads");
        const k = jobKeys(String(j.url));
        rows.push({
          ...k,
          soft_key: softKey(String(j.company), String(j.title)),
          company: String(j.company).slice(0, 200),
          title: String(j.title).slice(0, 300),
          url: String(j.url).slice(0, 2000),
          location: j.location ? String(j.location).slice(0, 200) : null,
          deadline: j.deadline ? String(j.deadline).slice(0, 50) : null,
          eligibility: ELIGIBILITY.has(elig) ? elig : "unstated",
          grad_year_evidence: j.grad_year_evidence ? String(j.grad_year_evidence).slice(0, 500) : null,
          priority: Number.isFinite(Number(j.priority)) ? Math.trunc(Number(j.priority)) : elig === "unstated" ? 0 : 10,
          index,
        });
      } catch (e) {
        errors.push({ index, error: (e as Error).message });
      }
    });
    // soft-key duplicates: against stored jobs, and within this batch
    const softs = [...new Set(rows.map((r) => r.soft_key))];
    const existingSoft = new Set<string>();
    for (let i = 0; i < softs.length; i += 90) {
      const chunk = softs.slice(i, i + 90);
      const { results } = await db.prepare(`SELECT soft_key FROM jobs WHERE soft_key IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ soft_key: string }>();
      results.forEach((r) => existingSoft.add(r.soft_key));
    }
    const seenSoft = new Set<string>();
    const seenDedupe = new Set<string>();
    let inserted = 0;
    const duplicates: { index: number; dedupe_key: string }[] = [];
    const possible: { index: number; soft_key: string }[] = [];
    const stmts: D1PreparedStatement[] = [];
    const order: any[] = [];
    for (const r of rows) {
      if (seenDedupe.has(r.dedupe_key)) {
        duplicates.push({ index: r.index, dedupe_key: r.dedupe_key });
        continue;
      }
      seenDedupe.add(r.dedupe_key);
      const isSoftDup = existingSoft.has(r.soft_key) || seenSoft.has(r.soft_key);
      seenSoft.add(r.soft_key);
      stmts.push(
        db
          .prepare(
            `INSERT INTO jobs (batch_id, dedupe_key, soft_key, site_key, company, title, url, ats, location, deadline, eligibility,
               grad_year_evidence, status, status_reason, priority, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
          )
          .bind(
            batch!.id, r.dedupe_key, r.soft_key, r.site_key, r.company, r.title, r.url, r.ats, r.location, r.deadline, r.eligibility,
            r.grad_year_evidence, isSoftDup ? "needs_human" : "pending", isSoftDup ? "possible_duplicate" : null, r.priority, t, t,
          ),
      );
      order.push({ ...r, isSoftDup });
    }
    for (let i = 0; i < stmts.length; i += 50) {
      const res = await db.batch(stmts.slice(i, i + 50));
      res.forEach((x, k) => {
        const r = order[i + k];
        if ((x.results as any[]).length) {
          inserted++;
          if (r.isSoftDup) possible.push({ index: r.index, soft_key: r.soft_key });
        } else duplicates.push({ index: r.index, dedupe_key: r.dedupe_key });
      });
    }
    await db.batch([
      db.prepare("UPDATE batches SET size = ? WHERE id = ?").bind(inserted, batch!.id),
      db.prepare("INSERT INTO config (key, value) VALUES ('batch_low_flagged','0') ON CONFLICT(key) DO UPDATE SET value='0'"),
    ]);
    await logEvent(db, "guardian", "jobs_pushed", null, { batch: batch!.id, inserted, duplicates: duplicates.length, possible: possible.length, errors: errors.length });
    return json({ batch_id: batch!.id, inserted, duplicates, possible_duplicates: possible, errors });
  }

  if (path === "/admin/jobs" && m === "GET") {
    const status = url.searchParams.get("status");
    const limit = Math.min(5000, Number(url.searchParams.get("limit")) || 500);
    const q = status
      ? db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY id LIMIT ?").bind(status, limit)
      : db.prepare("SELECT * FROM jobs ORDER BY id LIMIT ?").bind(limit);
    const { results } = await q.all<JobRow>();
    return json({ jobs: results.map(({ lease_token, ...rest }) => rest) });
  }

  if (path === "/admin/job-keys" && m === "GET") {
    const { results } = await db.prepare("SELECT dedupe_key, soft_key FROM jobs").all();
    return json({ keys: results });
  }

  const jm = path.match(/^\/admin\/jobs\/(\d+)$/);
  if (jm && m === "PATCH") {
    const id = Number(jm[1]);
    const b = await body();
    const status = String(b.status ?? "");
    if (!JOB_STATUSES.has(status)) return json({ error: `status must be one of ${[...JOB_STATUSES].join(", ")}` }, 400);
    const job = await db.prepare("SELECT status FROM jobs WHERE id = ?").bind(id).first<{ status: string }>();
    if (!job) return json({ error: "not found" }, 404);
    if (job.status === "submitted" && status !== "submitted" && !b.force) return json({ error: "job is submitted; pass force:true to change" }, 409);
    const t = Date.now();
    await db.batch([
      db
        .prepare(
          `UPDATE jobs SET status = ?, status_reason = ?, lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
             not_before = NULL, waiting_since = NULL, submitted_at = CASE WHEN ? = 'submitted' THEN COALESCE(submitted_at, ?) ELSE submitted_at END,
             expired_leases = CASE WHEN ? = 'pending' THEN 0 ELSE expired_leases END,
             attempts = CASE WHEN ? = 'pending' THEN 0 ELSE attempts END, updated_at = ? WHERE id = ?`,
        )
        .bind(status, b.reason ? String(b.reason).slice(0, 300) : `guardian:${status}`, status, t, status, status, t, id),
      db.prepare("UPDATE lease_history SET final_status = 'cancelled' WHERE job_id = ? AND final_status IS NULL").bind(id),
      db.prepare("DELETE FROM job_blockers WHERE job_id = ?").bind(id),
    ]);
    await logEvent(db, "guardian", "job_resolved", id, { from: job.status, to: status });
    return json({ ok: true, id, from: job.status, to: status });
  }

  // ---- questions
  if (path === "/admin/questions" && m === "GET") {
    const status = url.searchParams.get("status") ?? "open";
    const { results } = await db
      .prepare(
        `SELECT q.id, q.job_id, q.kind, q.question, q.options_json, q.context, q.word_limit, q.status, q.flags, q.created_at,
                j.company, j.title, j.url, j.site_key,
                (SELECT COUNT(*) FROM job_blockers b WHERE b.question_id = q.id) AS jobs_blocked
         FROM questions q LEFT JOIN jobs j ON j.id = q.job_id WHERE q.status = ? ORDER BY (q.kind = 'verification_code') DESC, q.id LIMIT 200`,
      )
      .bind(status)
      .all();
    return json({ questions: results });
  }

  const qm = path.match(/^\/admin\/questions\/(\d+)\/answer$/);
  if (qm && m === "POST") {
    const id = Number(qm[1]);
    const b = await body();
    const answer = String(b.answer ?? "").trim();
    if (!answer) return json({ error: "answer required" }, 400);
    const pii = forbiddenPii(answer);
    if (pii && !b.allow_pii) return json({ error: `refused: ${pii}` }, 400);
    const q = await db.prepare("SELECT * FROM questions WHERE id = ?").bind(id).first<{ id: number; kind: string; status: string; question: string; norm: string; job_id: number }>();
    if (!q) return json({ error: "not found" }, 404);
    if (q.status !== "open") return json({ error: `question is ${q.status}` }, 409);
    const t = Date.now();
    const stmts: D1PreparedStatement[] = [db.prepare("UPDATE questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status = 'open'").bind(answer, t, id)];
    if (q.kind === "essay") {
      const [cn, pn] = q.norm.split("|");
      const job = await db.prepare("SELECT company FROM jobs WHERE id = ?").bind(q.job_id).first<{ company: string }>();
      stmts.push(
        db
          .prepare(
            `INSERT INTO essays (company_norm, prompt_norm, company, prompt, text, created_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(company_norm, prompt_norm) DO UPDATE SET text = excluded.text`,
          )
          .bind(cn, pn ?? "", job?.company ?? cn, q.question, answer, t),
      );
    } else if (!JOB_SPECIFIC_KINDS.has(q.kind) && b.bank !== false) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO answer_bank (norm, question, answer, keywords, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(norm) DO UPDATE SET answer = excluded.answer, keywords = COALESCE(excluded.keywords, keywords)`,
          )
          .bind(q.norm, q.question, answer, b.keywords ? String(b.keywords) : null, t),
      );
    }
    stmts.push(promoteStmt(db, t));
    await db.batch(stmts);
    await logEvent(db, "guardian", "answered", q.job_id, { question_id: id, kind: q.kind });
    return json({ ok: true, id });
  }

  // ---- essays / profile / answer bank
  if (path === "/admin/essays" && m === "POST") {
    const b = await body();
    if (!b.company || !b.prompt || !b.text) return json({ error: "company, prompt, text required" }, 400);
    await db
      .prepare(
        `INSERT INTO essays (company_norm, prompt_norm, company, prompt, text, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(company_norm, prompt_norm) DO UPDATE SET text = excluded.text`,
      )
      .bind(normCompany(b.company), normText(b.prompt), String(b.company), String(b.prompt), String(b.text), Date.now())
      .run();
    return json({ ok: true });
  }

  if (path === "/admin/profile" && m === "PUT") {
    const b = await body();
    const entries = Object.entries(b ?? {}).filter(([k]) => /^[a-z0-9_]{1,60}$/.test(k));
    for (const [k, v] of entries) {
      const pii = forbiddenPii(`${k.replace(/_/g, " ")} ${v}`);
      if (pii) return json({ error: `refused ${k}: ${pii}` }, 400);
      if (/password|ssn|social_security|bank|card|passport|dob|birth/.test(k)) return json({ error: `refused key ${k}` }, 400);
    }
    const stmts = entries.map(([k, v]) =>
      v === null
        ? db.prepare("DELETE FROM profile WHERE key = ?").bind(k)
        : db.prepare("INSERT INTO profile (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, String(v)),
    );
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true, keys: entries.map(([k]) => k) });
  }
  if (path === "/admin/profile" && m === "GET") {
    const { results } = await db.prepare("SELECT key, value FROM profile ORDER BY key").all();
    return json({ profile: results });
  }

  if (path === "/admin/answer-bank" && m === "POST") {
    const b = await body();
    const list: any[] = Array.isArray(b) ? b : Array.isArray(b.entries) ? b.entries : [];
    const t = Date.now();
    const stmts: D1PreparedStatement[] = [];
    for (const e of list) {
      if (!e?.question || e.answer == null) return json({ error: "each entry needs question and answer" }, 400);
      const pii = forbiddenPii(`${e.question} ${e.answer}`);
      if (pii) return json({ error: `refused: ${pii}` }, 400);
      stmts.push(
        db
          .prepare(
            `INSERT INTO answer_bank (norm, question, answer, keywords, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(norm) DO UPDATE SET answer = excluded.answer, keywords = excluded.keywords`,
          )
          .bind(normText(e.question), String(e.question), String(e.answer), e.keywords ? String(e.keywords) : null, t),
      );
    }
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    return json({ ok: true, count: stmts.length });
  }
  if (path === "/admin/answer-bank" && m === "GET") {
    const { results } = await db.prepare("SELECT id, question, answer, keywords FROM answer_bank ORDER BY id").all();
    return json({ entries: results });
  }

  // ---- credentials
  if (path === "/admin/credentials" && m === "GET") {
    const { results } = await db.prepare("SELECT site_key, login_email, created_at, last_used_at, (password_ciphertext IS NOT NULL) AS has_password FROM credentials ORDER BY id").all();
    return json({ credentials: results });
  }
  const cm = path.match(/^\/admin\/credentials\/(.+)$/);
  if (cm && m === "GET") {
    const kt = req.headers.get("X-Keychain-Token") ?? "";
    if (!env.KEYCHAIN_TOKEN || !(await ctEqual(kt, env.KEYCHAIN_TOKEN))) {
      await bump(db, "admin_fail", 60 * MIN);
      return json({ error: "keychain token required" }, 401);
    }
    if ((await bump(db, "cred_reads", 60 * MIN)) > 500) return json({ error: "rate limited" }, 429);
    const siteKey = decodeURIComponent(cm[1]);
    const row = await db.prepare("SELECT * FROM credentials WHERE site_key = ?").bind(siteKey).first<any>();
    if (!row?.password_ciphertext) return json({ error: "not found" }, 404);
    const key = await importCredKey(env.CRED_KEY);
    const password = await decryptSecret(key, row.password_ciphertext, row.iv, row.site_key, row.id, row.key_version);
    await logEvent(db, "guardian", "credential_exported", null, { site_key: siteKey });
    return json({ site_key: row.site_key, login_email: row.login_email, password });
  }

  // ---- ops
  if (path === "/admin/stats" && m === "GET") {
    const cfg = await getConfig(db);
    await housekeeping(db, cfg);
    const p = await progress(db);
    const openQ = await db.prepare("SELECT kind, COUNT(*) AS n FROM questions WHERE status = 'open' GROUP BY kind").all<{ kind: string; n: number }>();
    const threshold = Number(cfg.batch_low_threshold ?? 25);
    return json({
      progress: p,
      open_questions: Object.fromEntries(openQ.results.map((r) => [r.kind, r.n])),
      batch_low: (p.pending ?? 0) + (p.ready ?? 0) < threshold,
      paused: cfg.paused === "1",
      config: cfg,
    });
  }
  if (path === "/admin/config" && m === "POST") {
    const b = await body();
    const entries = Object.entries(b ?? {}).filter(([k]) => CONFIG_KEYS.has(k));
    if (!entries.length) return json({ error: "no valid keys", allowed: [...CONFIG_KEYS] }, 400);
    await db.batch(entries.map(([k, v]) => db.prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, String(v))));
    await logEvent(db, "guardian", "config", null, Object.fromEntries(entries));
    return json({ ok: true });
  }
  if (path === "/admin/unlock" && m === "POST") {
    await db.prepare("DELETE FROM rate_limits WHERE key LIKE 'auth_fail%' OR key = 'admin_fail'").run();
    return json({ ok: true });
  }
  if (path === "/admin/revoke-grants" && m === "POST") {
    const list = await env.OAUTH_PROVIDER.listUserGrants("applicant");
    for (const g of list.items) await env.OAUTH_PROVIDER.revokeGrant(g.id, "applicant");
    await logEvent(db, "guardian", "grants_revoked", null, { count: list.items.length });
    return json({ ok: true, revoked: list.items.length });
  }
  if (path === "/admin/events" && m === "GET") {
    const since = Number(url.searchParams.get("since")) || 0;
    const type = url.searchParams.get("type");
    const q = type
      ? db.prepare("SELECT * FROM events WHERE id > ? AND type = ? ORDER BY id LIMIT 500").bind(since, type)
      : db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 500").bind(since);
    const { results } = await q.all();
    return json({ events: results });
  }
  if (path === "/admin/export.csv" && m === "GET") {
    const { results } = await db
      .prepare("SELECT id, company, title, url, ats, location, status, status_reason, attempts, confirmation, submitted_at, created_at FROM jobs ORDER BY id")
      .all<Record<string, unknown>>();
    const cols = ["id", "company", "title", "url", "ats", "location", "status", "status_reason", "attempts", "confirmation", "submitted_at", "created_at"];
    const cell = (v: unknown) => {
      let s = v == null ? "" : String(v);
      if (/^[=+\-@]/.test(s)) s = "'" + s; // spreadsheet formula injection
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(","), ...results.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" } });
  }
  return json({ error: "not found" }, 404);
}
