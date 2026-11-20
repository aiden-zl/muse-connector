# muse-connector

A free MCP "bridge" connector that lets **Claude (the guardian)** run **Meta Muse (the worker)** as a job-application
engine. Muse spends *its* usage on the browser work (opening postings, creating portal accounts, filling forms,
submitting). Claude spends very little: it sources jobs in 300-row batches, answers new questions, writes tailored
essays, and handles anything unusual.

```
Muse ──OAuth + Streamable HTTP──▶ Cloudflare Worker (free) ──▶ D1 database
                                   ▲
Claude ── guardian CLI (admin API) ┘   + macOS Keychain mirror of portal passwords
```

## Status: built and tested locally, not deployed yet

- 22 unit tests and 41 end-to-end tests pass (`npm test`, `npm run e2e`). The end-to-end tests drive a real MCP client
  through the full OAuth flow against `wrangler dev`.
- Deploying needs **your** Cloudflare login, which can't be done unattended.

## Unverified assumptions

1. **Custom connectors in Muse.** One third-party guide says Muse accepts them (remote Streamable HTTP over HTTPS, with
   OAuth). Meta has not published this. The bridge follows the strictest version of that description: OAuth 2.1,
   dynamic client registration, PKCE (S256), and the RFC 9728/8414 metadata.
2. **Muse keeping the loop going.** Nobody has confirmed that Muse will keep calling tools across hundreds of jobs.
   The bridge works around this: every response (errors too) includes a machine-readable `next_action` saying
   exactly which tool to call next, with the ids filled in.
3. **Muse's tool-call timeout** is unknown. `wait_for_code` waits 20 s per call; change it with
   `guardian config code_wait_s=10`.
4. **Free-plan CPU.** The Cloudflare free plan allows 10 ms of CPU per request. If requests start failing with CPU
   limit errors, Workers Paid ($5/mo) removes the limit. Nothing else needs to change.

## Setup (3 steps)

```bash
npm install
npm run deploy          # opens Cloudflare login once, then creates DB/KV/secrets and deploys
```
1. The deploy script prints a **connector URL** (`https://muse-bridge.<you>.workers.dev/mcp`) and a **passphrase**.
2. In Muse: **Settings → Connectors → Add custom connector**. Paste the URL and choose OAuth. Muse opens an approval
   page. Check that the redirect host is Muse's, type the passphrase, and click Approve.
3. Load your data (the guardian can do this for you):
   ```bash
   node guardian/cli.mjs profile-set my-profile.json        # see templates/profile.example.json
   node guardian/cli.mjs bank-add my-answers.json           # see templates/answer-bank.example.json
   node guardian/cli.mjs push-jobs batches/batch-001.csv    # from the sourcer
   ```

Then tell Muse:

> Use the **muse-bridge** connector. Call `start_session` and follow `next_action` in every response until it says
> to stop. Apply to every job it gives you, exactly as its steps and rules say. Never pay for anything or sign in with
> Google, Meta or LinkedIn.

## How a job flows

```
pending → leased → (begin_submit) submitting → submitted
leased → defer (waiting on guardian) → waiting → ready → leased again (ready jobs go first)
leased → failed → pending (30-min cool-down) → needs_human after 3 failures
submitting + lease expired → possibly_submitted   ← never re-issued automatically
```

**No duplicate applications:**
- **Dedupe keys built from the ATS and job id.** Greenhouse, Lever, Ashby, Workday and SmartRecruiters each get one,
  so the same job reached through different URLs is caught.
- **Fuzzy matching.** The same internship posted on two sites is flagged to the guardian.
- **A guard around the Submit click.** Muse calls `begin_submit` right before clicking Submit. If the lease then
  expires, the job is parked as `possibly_submitted` and is never handed out again automatically.
- **A check on re-issued jobs.** When a job is handed out a second time, Muse first checks the portal's
  "My Applications" page.

## Credentials

- **One password per portal account.** `get_or_create_credential` generates a unique password for each account scope
  (`wd:<tenant>`, `gh:<board>` and so on). It works out the account from the **job's URL**, never from what Muse
  asks for.
- **Storage.** Passwords are encrypted with AES-GCM and stored, then reused every time that portal comes up again.
- **Keychain mirror.** `guardian sync-keychain` copies them into your macOS Keychain under `muse-bridge/<hash>`
  entries. Each entry's label shows the site.
- **Limits:**
  - Muse sees every password it is given, and Meta may retain it. Use a separate application email, never your main
    one.
  - The bridge never stores email, Google or Meta passwords, an SSN, bank or card details, or a date of birth. The
    server rejects them.
  - Anyone who has both `CRED_KEY` and a dump of the D1 database can read every portal password. Both stay in your
    Cloudflare account and `~/.config/muse-bridge/`.

## Guardian CLI

```
node guardian/cli.mjs watch            # everything needing attention, as JSON
node guardian/cli.mjs questions        # open questions (Muse text wrapped in <untrusted_muse_text>)
node guardian/cli.mjs answer 12 "Yes"  # answers are banked for reuse (not verification codes)
node guardian/cli.mjs answer 13 @essay.txt
node guardian/cli.mjs resolve 40 submitted|pending|skipped
node guardian/cli.mjs status | pause | resume | export | sync-keychain | revoke-grants
```

See [docs/GUARDIAN.md](docs/GUARDIAN.md) for the guardian's operating rules.

## Job sourcer

`node sourcer/source.mjs --out batches/batch-001.csv --limit 300` pulls public Greenhouse, Lever and Ashby boards for
a seed list of SWE and quant companies and keeps internship titles. It records grad-year evidence and drops postings
that exclude 2029 graduates, and skips jobs the bridge already has.

## Development

```bash
npm test          # unit
npm run e2e       # full local end-to-end (wrangler dev + real MCP client + OAuth)
npm run typecheck
```
