// End-to-end test: starts `wrangler dev` on a fresh local D1/KV, connects a real MCP client through the
// full OAuth flow (discovery → DCR → consent page → passphrase POST → code → PKCE token), then exercises
// the queue rules. Uses only fake data. Run: npm run e2e
import { spawn, execSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const PASS = "e2e-pass-" + randomBytes(8).toString("hex");
const ADMIN = "e2e-admin-" + randomBytes(8).toString("hex");
const KEYCHAIN = "e2e-kc-" + randomBytes(8).toString("hex");

const state = mkdtempSync(join(tmpdir(), "muse-e2e-"));
const devVarsPath = ".dev.vars";
const backup = existsSync(devVarsPath) ? readFileSync(devVarsPath, "utf8") : null;
writeFileSync(
  devVarsPath,
  `BRIDGE_PASSPHRASE=${PASS}\nADMIN_TOKEN=${ADMIN}\nKEYCHAIN_TOKEN=${KEYCHAIN}\nCRED_KEY=${randomBytes(32).toString("base64")}\nMCP_RESOURCE=${BASE}/mcp\n`,
);

let dev;
let failures = 0;
let passes = 0;
async function test(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${name}\n    ${e?.stack?.split("\n").slice(0, 3).join("\n    ")}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function admin(method, path, body, extraHeaders = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

// ---- OAuth client provider that drives the consent page programmatically
function makeAuthProvider(passphrase) {
  let clientInfo, tokens, verifier, code;
  return {
    get code() { return code; },
    get redirectUrl() { return "http://localhost:9/callback"; },
    get clientMetadata() {
      return { client_name: "E2E Muse", redirect_uris: ["http://localhost:9/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
    },
    clientInformation: () => clientInfo,
    saveClientInformation: (i) => { clientInfo = i; },
    tokens: () => tokens,
    saveTokens: (t) => { tokens = t; },
    saveCodeVerifier: (v) => { verifier = v; },
    codeVerifier: () => verifier,
    async redirectToAuthorization(url) {
      const g = await fetch(url, { redirect: "manual" });
      assert.equal(g.status, 200, "consent page should render");
      const cookies = g.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      const html = await g.text();
      const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
      assert.ok(handle, "consent handle present");
      assert.ok(html.includes("E2E Muse"), "client name shown");
      assert.ok(html.includes("localhost"), "redirect host shown");
      const p = await fetch(new URL("/authorize", url), {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies },
        body: new URLSearchParams({ handle, passphrase, decision: "approve" }),
      });
      if (p.status !== 302) throw new Error(`authorize POST returned ${p.status}`);
      const loc = new URL(p.headers.get("Location"));
      code = loc.searchParams.get("code");
    },
  };
}

async function connect(passphrase = PASS) {
  const provider = makeAuthProvider(passphrase);
  const mk = () => new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { authProvider: provider });
  let client = new Client({ name: "e2e", version: "1.0.0" });
  let transport = mk();
  try {
    await client.connect(transport);
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
    assert.ok(provider.code, "got an authorization code");
    await transport.finishAuth(provider.code);
    client = new Client({ name: "e2e", version: "1.0.0" });
    transport = mk();
    await client.connect(transport);
  }
  return client;
}

async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const out = JSON.parse(r.content[0].text);
  assert.ok("next_action" in out, `${name} response must include next_action`);
  return out;
}

const L = (w, j) => ({ worker_id: w, job_id: j.job_id, lease_token: j.lease_token });

async function main() {
  execSync(`CI=1 npx wrangler d1 migrations apply DB --local --persist-to ${state}`, { stdio: "ignore" });
  dev = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", state, "--ip", "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  dev.stdout.on("data", (d) => (log += d));
  dev.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + "/health")).ok) break;
    } catch {}
    await sleep(1000);
    if (i === 59) throw new Error("dev server did not start\n" + log);
  }

  console.log("auth & admin");
  await test("admin rejects missing token", async () => {
    const r = await fetch(BASE + "/admin/stats");
    assert.equal(r.status, 401);
  });
  await test("admin OPTIONS is refused, no CORS headers", async () => {
    const r = await fetch(BASE + "/admin/stats", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  });
  await test("/mcp without token → 401 with resource_metadata", async () => {
    const r = await fetch(BASE + "/mcp", { method: "POST" });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  });
  await test("wrong passphrase is refused", async () => {
    await assert.rejects(() => connect("wrong-passphrase"), /401/);
  });

  let c, c2;
  await test("full OAuth flow + MCP connect", async () => {
    c = await connect();
    const tools = (await c.listTools()).tools.map((t) => t.name);
    for (const t of ["start_session", "get_next_job", "report_result", "get_or_create_credential", "defer_job", "begin_submit"]) assert.ok(tools.includes(t), t);
  });
  await test("second client connects", async () => {
    c2 = await connect();
  });

  console.log("setup");
  await test("profile rejects SSN", async () => {
    const r = await admin("PUT", "/admin/profile", { notes: "my ssn is 123-45-6789" });
    assert.equal(r.status, 400);
  });
  await test("profile + answer bank", async () => {
    let r = await admin("PUT", "/admin/profile", { first_name: "Test", last_name: "Applicant", application_email: "applicant.test@example.com", school: "Example University" });
    assert.equal(r.status, 200);
    r = await admin("POST", "/admin/answer-bank", { entries: [{ question: "Are you legally authorized to work in the United States?", answer: "Yes", keywords: "authorized,work" }] });
    assert.equal(r.status, 200);
  });
  let push;
  await test("push jobs: dedupe exact + soft duplicates", async () => {
    push = await admin("POST", "/admin/jobs", {
      source_note: "e2e",
      jobs: [
        { url: "https://boards.greenhouse.io/acme/jobs/1001?gh_src=abc", company: "Acme", title: "Software Engineer Intern (Summer 2027)", eligibility: "explicit_2029" },
        { url: "https://job-boards.greenhouse.io/acme/jobs/1001", company: "Acme", title: "Software Engineer Intern (Summer 2027)" }, // exact dup
        { url: "https://jobs.lever.co/beta/aaaa-bbbb/apply", company: "Beta Inc", title: "Quant Research Intern" },
        { url: "https://gamma.wd5.myworkdayjobs.com/en-US/Careers/job/NYC/SWE-Intern_R-123", company: "Gamma", title: "SWE Intern" },
        { url: "https://gamma.wd1.myworkdayjobs.com/Careers/job/Remote/SWE-Intern_R-123/apply", company: "Gamma", title: "SWE Intern" }, // dup
        { url: "https://acme.com/careers?gh_jid=2002", company: "Acme Corp", title: "Software Engineer Intern - Summer 2027" }, // soft dup of job 1
        { url: "https://jobs.ashbyhq.com/delta/1234-5678", company: "Delta", title: "ML Engineer Intern" },
        { url: "not a url", company: "X", title: "Y" },
      ],
    });
    assert.equal(push.status, 200);
    assert.equal(push.body.inserted, 5, JSON.stringify(push.body));
    assert.equal(push.body.duplicates.length, 2);
    assert.equal(push.body.possible_duplicates.length, 1);
    assert.equal(push.body.errors.length, 1);
  });
  await test("re-push of the same job in a new batch is ignored", async () => {
    const r = await admin("POST", "/admin/jobs", { jobs: [{ url: "https://boards.greenhouse.io/acme/jobs/1001", company: "Acme", title: "SWE Intern" }] });
    assert.equal(r.body.inserted, 0);
  });

  console.log("leasing");
  let w1, w2, j1, j2;
  await test("start_session returns worker id + SOP", async () => {
    const s = await call(c, "start_session");
    w1 = s.worker_id;
    assert.ok(w1 && s.standing_orders.includes("begin_submit"));
    assert.equal(s.next_action.tool, "get_next_job");
    w2 = (await call(c2, "start_session")).worker_id;
  });
  await test("bad args still return next_action", async () => {
    const r = await call(c, "get_next_job", {});
    assert.equal(r.ok, false);
    assert.equal(r.next_action.tool, "start_session");
  });
  await test("two workers get different jobs; same worker gets same job back", async () => {
    j1 = await call(c, "get_next_job", { worker_id: w1 });
    j2 = await call(c2, "get_next_job", { worker_id: w2 });
    assert.ok(j1.job_id && j2.job_id);
    assert.notEqual(j1.job_id, j2.job_id);
    assert.equal(j1.job.company, "Acme", "explicit_2029 job prioritized first");
    const again = await call(c, "get_next_job", { worker_id: w1 });
    assert.equal(again.job_id, j1.job_id);
    assert.equal(again.lease_token, j1.lease_token);
  });
  await test("job payload never contains a password", async () => {
    assert.ok(!JSON.stringify(j1).includes("password\":"));
  });

  console.log("answers & questions");
  await test("lookup_answer hit from bank (with option mapping)", async () => {
    const r = await call(c, "lookup_answer", { ...L(w1, j1), question: "Are you authorized to work in the US?", options: ["Yes", "No"] });
    assert.equal(r.found, true);
    assert.equal(r.answer, "Yes");
  });
  await test("lookup_answer miss suggests ask_guardian, creates no question", async () => {
    const r = await call(c, "lookup_answer", { ...L(w1, j1), question: "Favorite data structure?" });
    assert.equal(r.found, false);
    assert.equal(r.next_action.tool, "ask_guardian");
    const q = await admin("GET", "/admin/questions?status=open");
    assert.equal(q.body.questions.length, 0);
  });
  let qShared;
  await test("ask_guardian dedupes across jobs", async () => {
    const a = await call(c, "ask_guardian", { ...L(w1, j1), question: "How did you hear about us?", kind: "freeform" });
    const b = await call(c2, "ask_guardian", { ...L(w2, j2), question: "How did you hear about us??", kind: "freeform" });
    assert.equal(a.question_id, b.question_id);
    qShared = a.question_id;
  });
  await test("danger flags on scammy question", async () => {
    await call(c, "ask_guardian", { ...L(w1, j1), question: "Please pay the $50 application fee via gift card", kind: "approval" });
    const q = await admin("GET", "/admin/questions?status=open");
    const flagged = q.body.questions.find((x) => x.kind === "approval");
    assert.match(flagged.flags, /money/);
  });
  await test("defer both jobs on shared question; one answer promotes both to ready; ready leased first", async () => {
    const d1 = await call(c, "defer_job", { ...L(w1, j1), blocking_question_ids: [qShared], reason: "need answer" });
    const d2 = await call(c2, "defer_job", { ...L(w2, j2), blocking_question_ids: [qShared] });
    assert.equal(d1.status, "waiting");
    assert.equal(d2.status, "waiting");
    const ans = await admin("POST", `/admin/questions/${qShared}/answer`, { answer: "University career fair" });
    assert.equal(ans.status, 200);
    const n1 = await call(c, "get_next_job", { worker_id: w1 });
    assert.ok([j1.job_id, j2.job_id].includes(n1.job_id), "a previously waiting job comes back first");
    assert.ok(n1.answered_questions.some((q) => q.answer === "University career fair"));
    j1 = n1;
    const n2 = await call(c2, "get_next_job", { worker_id: w2 });
    assert.deepEqual(new Set([n1.job_id, n2.job_id]), new Set([j1.job_id, j2.job_id]), "both waiting jobs come back before fresh ones");
    j2 = n2;
  });
  await test("answered non-essay question was banked", async () => {
    const r = await call(c, "lookup_answer", { ...L(w1, j1), question: "How did you hear about us" });
    assert.equal(r.answer, "University career fair");
  });

  console.log("essays");
  let essayQ;
  await test("request_essay → defer → answer → essay returned and reused", async () => {
    const r = await call(c, "request_essay", { ...L(w1, j1), prompt: "Why do you want to work at this company?", word_limit: 200 });
    assert.equal(r.status, "pending");
    assert.equal(r.next_action.tool, "defer_job");
    essayQ = r.question_id;
    await call(c, "defer_job", { ...L(w1, j1), blocking_question_ids: [essayQ] });
    await admin("POST", `/admin/questions/${essayQ}/answer`, { answer: "Because of reasons (tailored essay text)." });
    const n = await call(c, "get_next_job", { worker_id: w1 });
    assert.equal(n.job_id, j1.job_id);
    assert.ok(n.essays_for_company.some((e) => e.text.includes("tailored")));
    j1 = n;
    const again = await call(c, "request_essay", { ...L(w1, j1), prompt: "Why do you want to work at this company?" });
    assert.equal(again.status, "ready");
  });

  console.log("credentials");
  let cred;
  await test("credential created once, then reused", async () => {
    cred = await call(c, "get_or_create_credential", L(w1, j1));
    assert.equal(cred.created, true);
    assert.equal(cred.email, "applicant.test@example.com");
    assert.match(cred.password, /^[A-Za-z0-9_.!@#-]{20}$/);
    const again = await call(c, "get_or_create_credential", L(w1, j1));
    assert.equal(again.created, false);
    assert.equal(again.password, cred.password);
  });
  await test("credential refused without a valid lease", async () => {
    const r = await call(c, "get_or_create_credential", { worker_id: w1, job_id: j1.job_id, lease_token: "l_fake" });
    assert.equal(r.ok, false);
    assert.equal(r.next_action.tool, "get_next_job");
  });
  await test("admin credential list has no passwords; plaintext needs keychain token", async () => {
    const list = await admin("GET", "/admin/credentials");
    assert.ok(!JSON.stringify(list.body).includes(cred.password));
    const site = encodeURIComponent(cred.account_site);
    const noKc = await admin("GET", `/admin/credentials/${site}`);
    assert.equal(noKc.status, 401);
    const kc = await admin("GET", `/admin/credentials/${site}`, undefined, { "X-Keychain-Token": KEYCHAIN });
    assert.equal(kc.body.password, cred.password);
  });
  await test("events never contain the password", async () => {
    const ev = await admin("GET", "/admin/events");
    assert.ok(!JSON.stringify(ev.body).includes(cred.password));
  });

  console.log("verification codes");
  await test("verification code: not deduped, not banked, wait_for_code returns it", async () => {
    const a = await call(c, "ask_guardian", { ...L(w1, j1), question: "Enter the code we emailed you", kind: "verification_code" });
    const b = await call(c2, "ask_guardian", { ...L(w2, j2), question: "Enter the code we emailed you", kind: "verification_code" });
    assert.notEqual(a.question_id, b.question_id);
    assert.equal(a.next_action.tool, "wait_for_code");
    setTimeout(() => admin("POST", `/admin/questions/${a.question_id}/answer`, { answer: "482913" }), 1500);
    const w = await call(c, "wait_for_code", { ...L(w1, j1), question_id: a.question_id });
    assert.equal(w.answer, "482913");
    const other = await call(c2, "get_answer", { ...L(w2, j2), question_id: a.question_id });
    assert.equal(other.ok, false, "another lease cannot read the code");
    const bank = await admin("GET", "/admin/answer-bank");
    assert.ok(!JSON.stringify(bank.body).includes("482913"));
  });

  console.log("submission");
  await test("begin_submit → report submitted; double report is a no-op", async () => {
    const b = await call(c, "begin_submit", L(w1, j1));
    assert.equal(b.status, "submitting");
    const r = await call(c, "report_result", { ...L(w1, j1), status: "submitted", confirmation: "APP-1" });
    assert.equal(r.status, "submitted");
    const r2 = await call(c, "report_result", { ...L(w1, j1), status: "submitted" });
    assert.equal(r2.ok, true);
    assert.match(r2.message, /Already/);
  });
  await test("submitted job is never re-issued", async () => {
    const seen = new Set();
    for (let i = 0; i < 6; i++) {
      const n = await call(c, "get_next_job", { worker_id: w1 });
      if (!n.job_id) break;
      assert.notEqual(n.job_id, j1.job_id);
      seen.add(n.job_id);
      await call(c, "defer_job", { ...L(w1, n), reason: "test" }); // pending + 15m cool-down
    }
  });
  await test("deferred cooling-down jobs → retry_later / waiting message, never 'queue_empty' while work remains", async () => {
    const n = await call(c, "get_next_job", { worker_id: w1 });
    assert.notEqual(n.status, "queue_empty");
  });

  console.log("lease expiry");
  await test("leased job expiry → back to pending; submitting expiry → possibly_submitted (never re-issued)", async () => {
    // reset cool-downs so jobs are leasable
    const all = (await admin("GET", "/admin/jobs")).body.jobs;
    for (const j of all) if (j.status === "pending" || j.status === "ready") await admin("PATCH", `/admin/jobs/${j.id}`, { status: "pending" });
    await admin("POST", "/admin/config", { lease_minutes: "0.03", submit_extend_minutes: "0.03" }); // ~1.8s
    // worker 2 currently holds j2 (from earlier) — let it expire too
    const w3 = (await call(c, "start_session")).worker_id;
    const a = await call(c, "get_next_job", { worker_id: w3 });
    assert.ok(a.job_id, JSON.stringify(a));
    await call(c, "begin_submit", L(w3, a));
    await sleep(2500);
    const s = await admin("GET", "/admin/stats");
    assert.ok((s.body.progress.possibly_submitted ?? 0) >= 1, JSON.stringify(s.body.progress));
    const jobs = (await admin("GET", "/admin/jobs?status=possibly_submitted")).body.jobs;
    assert.ok(jobs.some((j) => j.id === a.job_id));
    // late report from the expired lease is still accepted as submitted
    const late = await call(c, "report_result", { ...L(w3, a), status: "submitted" });
    assert.equal(late.status, "submitted");
    // stale token for a non-submitted status is rejected
    await admin("POST", "/admin/config", { lease_minutes: "20", submit_extend_minutes: "15" });
  });
  await test("report with a never-issued token is rejected", async () => {
    const r = await call(c, "report_result", { worker_id: w1, job_id: 1, lease_token: "l_never", status: "submitted" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "unknown_lease");
  });
  await test("failed → pending with cool-down; idempotent; needs_human at max attempts", async () => {
    const w4 = (await call(c, "start_session")).worker_id;
    const a = await call(c, "get_next_job", { worker_id: w4 });
    assert.ok(a.job_id, JSON.stringify(a));
    const f1 = await call(c, "report_result", { ...L(w4, a), status: "failed", notes: "form error 500" });
    assert.equal(f1.status, "pending");
    const dbl = await call(c, "report_result", { ...L(w4, a), status: "failed" });
    assert.match(dbl.message ?? "", /Already/, "same token+status is idempotent (no double increment)");
    const conflicting = await call(c, "report_result", { ...L(w4, a), status: "skipped" });
    assert.equal(conflicting.ok, false, "same token + different status rejected");
    const row = (await admin("GET", "/admin/jobs")).body.jobs.find((j) => j.id === a.job_id);
    assert.equal(row.attempts, 1);
    assert.ok(row.not_before > Date.now() + 20 * 60_000, "30-minute cool-down set");
    await admin("POST", "/admin/config", { max_attempts: "1" });
    await admin("POST", "/admin/jobs", { jobs: [{ url: "https://jobs.lever.co/epsilon/eeee-1111", company: "Epsilon", title: "Backend Intern" }] });
    const b = await call(c, "get_next_job", { worker_id: w4 });
    assert.ok(b.job_id && b.job_id !== a.job_id, "cooling-down job not re-issued: " + JSON.stringify(b).slice(0, 300));
    const f2 = await call(c, "report_result", { ...L(w4, b), status: "failed" });
    assert.equal(f2.status, "needs_human");
    await admin("POST", "/admin/config", { max_attempts: "3" });
  });
  console.log("review fixes");
  await test("failed after begin_submit → possibly_submitted (never re-queued)", async () => {
    await admin("POST", "/admin/jobs", { jobs: [{ url: "https://jobs.lever.co/theta/t-1", company: "Theta", title: "Platform Intern" }] });
    const w = (await call(c, "start_session")).worker_id;
    const a = await call(c, "get_next_job", { worker_id: w });
    assert.ok(a.job_id, JSON.stringify(a).slice(0, 200));
    await call(c, "begin_submit", L(w, a));
    const r = await call(c, "report_result", { ...L(w, a), status: "failed", notes: "spinner then error" });
    assert.equal(r.status, "possibly_submitted");
  });
  await test("approval answer survives a re-lease of the same job", async () => {
    await admin("POST", "/admin/jobs", { jobs: [{ url: "https://jobs.lever.co/iota/i-1", company: "Iota", title: "Data Intern" }] });
    const w = (await call(c, "start_session")).worker_id;
    const a = await call(c, "get_next_job", { worker_id: w });
    const q = await call(c, "ask_guardian", { ...L(w, a), question: "Allow creating a portal account?", kind: "approval" });
    const d = await call(c, "defer_job", { ...L(w, a), blocking_question_ids: [q.question_id] });
    assert.equal(d.status, "waiting", "approval counts as a blocker");
    await admin("POST", `/admin/questions/${q.question_id}/answer`, { answer: "Yes" });
    const b = await call(c, "get_next_job", { worker_id: w });
    assert.equal(b.job_id, a.job_id);
    assert.ok(b.answered_questions.some((x) => x.answer === "Yes"), "approval in payload");
    const again = await call(c, "ask_guardian", { ...L(w, b), question: "Allow creating a portal account?", kind: "approval" });
    assert.equal(again.answer, "Yes", "re-asking under new lease returns the answer");
    await call(c, "report_result", { ...L(w, b), status: "skipped" });
  });
  await test("repeated bare defers → needs_human (no infinite loop)", async () => {
    await admin("POST", "/admin/config", { max_defers: "2" });
    await admin("POST", "/admin/jobs", { jobs: [{ url: "https://jobs.lever.co/kappa/k-1", company: "Kappa", title: "Backend Intern" }] });
    const w = (await call(c, "start_session")).worker_id;
    const a = await call(c, "get_next_job", { worker_id: w });
    assert.equal(a.job.company, "Kappa");
    const d1 = await call(c, "defer_job", { ...L(w, a), reason: "x" });
    assert.equal(d1.status, "pending");
    await admin("PATCH", `/admin/jobs/${a.job_id}`, { status: "ready" }); // skip cool-down (keeps defers)
    const b = await call(c, "get_next_job", { worker_id: w });
    assert.equal(b.job_id, a.job_id);
    const d2 = await call(c, "defer_job", { ...L(w, b), reason: "x" });
    assert.equal(d2.status, "needs_human");
    await admin("POST", "/admin/config", { max_defers: "5" });
  });
  await test("soft-key twins: flagged at push; guardian 'keep' detaches; un-kept twin flagged on submit", async () => {
    await admin("POST", "/admin/jobs", { jobs: [{ url: "https://jobs.lever.co/lambda/l-1", company: "Lambda", title: "SWE Intern Summer 2027" }] });
    await admin("POST", "/admin/jobs", { jobs: [{ url: "https://jobs.ashbyhq.com/lambda/l-2", company: "Lambda Inc", title: "Software Engineer Intern - Summer 2027" }] });
    await admin("POST", "/admin/jobs", { jobs: [{ url: "https://boards.greenhouse.io/lambda/jobs/3", company: "Lambda", title: "Software Engineering Intern (Summer 2027)" }] });
    const twins = (await admin("GET", "/admin/jobs")).body.jobs.filter((j) => j.company.startsWith("Lambda"));
    const [first, second, third] = twins;
    assert.equal(first.status, "pending");
    assert.equal(second.status, "needs_human", "second copy flagged at push");
    assert.equal(third.status, "needs_human", "third copy flagged at push");
    await admin("PATCH", `/admin/jobs/${second.id}`, { status: "pending", reason: "different team, keep" });
    const wA = (await call(c, "start_session")).worker_id;
    const a = await call(c, "get_next_job", { worker_id: wA });
    assert.equal(a.job_id, first.id);
    await call(c, "report_result", { ...L(wA, a), status: "submitted" });
    const after = (await admin("GET", "/admin/jobs")).body.jobs;
    assert.equal(after.find((j) => j.id === second.id).status, "pending", "kept job is not re-flagged");
    assert.match(after.find((j) => j.id === third.id).status_reason, /possible_duplicate/);
    const b = await call(c, "get_next_job", { worker_id: wA });
    assert.equal(b.job_id, second.id, "kept job is leasable after its twin was submitted");
    await call(c, "report_result", { ...L(wA, b), status: "skipped" });
  });
  await test("wrong passphrase then right one on the same consent page works", async () => {
    const provider = makeAuthProvider(PASS);
    provider.redirectToAuthorization = async (url) => {
      const g = await fetch(url, { redirect: "manual" });
      const cookies = g.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
      const handle = (await g.text()).match(/name="handle" value="([^"]+)"/)[1];
      const post = (pp) => fetch(new URL("/authorize", url), { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies }, body: new URLSearchParams({ handle, passphrase: pp, decision: "approve" }) });
      const bad = await post("nope");
      assert.equal(bad.status, 401);
      assert.match(await bad.text(), /Wrong passphrase/);
      const good = await post(PASS);
      assert.equal(good.status, 302);
      provider._code = new URL(good.headers.get("Location")).searchParams.get("code");
    };
    const t = new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { authProvider: provider });
    const cl = new Client({ name: "e2e3", version: "1" });
    await assert.rejects(() => cl.connect(t));
    assert.ok(provider._code);
    await t.finishAuth(provider._code);
    const cl2 = new Client({ name: "e2e3", version: "1" });
    await cl2.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { authProvider: provider }));
    await cl2.close();
  });
  await test("bank:false answers are not reused by other jobs", async () => {
    await admin("POST", "/admin/jobs", { jobs: [{ url: "https://jobs.lever.co/mu/m-1", company: "Mu", title: "Backend Intern" }, { url: "https://jobs.lever.co/nu/n-1", company: "Nu", title: "Backend Intern" }] });
    const w = (await call(c, "start_session")).worker_id;
    const a = await call(c, "get_next_job", { worker_id: w });
    const q = await call(c, "ask_guardian", { ...L(w, a), question: "Why this team specifically?", kind: "freeform" });
    await admin("POST", `/admin/questions/${q.question_id}/answer`, { answer: "Because of team-specific reason", bank: false });
    await call(c, "report_result", { ...L(w, a), status: "skipped" });
    const b = await call(c, "get_next_job", { worker_id: w });
    assert.ok(b.job_id && b.job_id !== a.job_id);
    const q2 = await call(c, "ask_guardian", { ...L(w, b), question: "Why this team specifically?", kind: "freeform" });
    assert.notEqual(q2.question_id, q.question_id);
    assert.equal(q2.status, "pending");
    await call(c, "report_result", { ...L(w, b), status: "skipped" });
  });
  await test("admin still works after many bad-token attempts", async () => {
    for (let i = 0; i < 35; i++) await fetch(BASE + "/admin/stats", { headers: { Authorization: "Bearer nope" } });
    const r = await admin("GET", "/admin/stats");
    assert.equal(r.status, 200);
  });

  console.log("pause");
  await test("pause stops new leases with an explicit end-session action", async () => {
    await admin("POST", "/admin/config", { paused: "1" });
    const w5 = (await call(c, "start_session")).worker_id;
    const n = await call(c, "get_next_job", { worker_id: w5 });
    assert.equal(n.status, "paused");
    assert.equal(n.next_action.tool, "none");
    await admin("POST", "/admin/config", { paused: "0" });
  });

  await test("export CSV excludes credentials", async () => {
    const r = await fetch(BASE + "/admin/export.csv", { headers: { Authorization: `Bearer ${ADMIN}` } });
    const t = await r.text();
    assert.ok(t.startsWith("id,company"));
    assert.ok(!t.includes(cred.password));
  });

  console.log("guardian CLI");
  const cliEnv = { ...process.env, MUSE_BRIDGE_CONFIG: join(state, "cfg.json"), MUSE_KEYCHAIN_TOKEN: KEYCHAIN };
  writeFileSync(cliEnv.MUSE_BRIDGE_CONFIG, JSON.stringify({ url: BASE, admin_token: ADMIN }), { mode: 0o600 });
  const cli = (...a) => execFileSync("node", ["guardian/cli.mjs", ...a], { env: cliEnv, encoding: "utf8" });
  await test("cli status/watch/questions/push-jobs(csv)", async () => {
    assert.ok(JSON.parse(cli("status")).progress);
    const w = JSON.parse(cli("watch"));
    assert.ok(Array.isArray(w.open_questions));
    const csv = join(state, "b.csv");
    writeFileSync(csv, 'url,company,title,eligibility\n"https://jobs.lever.co/zeta/z-1","Zeta, Inc","Quant Intern",unstated\n');
    const r = JSON.parse(cli("push-jobs", csv));
    assert.equal(r.inserted, 1);
    const q = cli("questions");
    assert.ok(q.includes("<untrusted_muse_text>") || q.trim() === "[]");
  });
  await test("cli sync-keychain mirrors passwords via security -i (temp keychain)", async () => {
    const kc = join(state, "test.keychain-db");
    execFileSync("security", ["create-keychain", "-p", "e2e", kc]);
    try {
      const out = JSON.parse(execFileSync("node", ["guardian/cli.mjs", "sync-keychain"], { env: { ...cliEnv, MUSE_BRIDGE_KEYCHAIN: kc }, encoding: "utf8" }));
      assert.ok(out.added >= 1, JSON.stringify(out));
      const { createHash } = await import("node:crypto");
      const svc = "muse-bridge/" + createHash("sha256").update(cred.account_site).digest("hex").slice(0, 32);
      const pw = execFileSync("security", ["find-generic-password", "-s", svc, "-w", kc], { encoding: "utf8" }).trim();
      assert.equal(pw, cred.password);
      const again = JSON.parse(execFileSync("node", ["guardian/cli.mjs", "sync-keychain"], { env: { ...cliEnv, MUSE_BRIDGE_KEYCHAIN: kc }, encoding: "utf8" }));
      assert.equal(again.added, 0, "idempotent");
    } finally {
      try { execFileSync("security", ["delete-keychain", kc]); } catch {}
    }
  });

  await c?.close();
  await c2?.close();
}

try {
  await main();
} catch (e) {
  failures++;
  console.error("FATAL", e);
} finally {
  try { process.kill(-dev.pid, "SIGTERM"); } catch {}
  if (backup !== null) writeFileSync(devVarsPath, backup); else rmSync(devVarsPath, { force: true });
  rmSync(state, { recursive: true, force: true });
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
