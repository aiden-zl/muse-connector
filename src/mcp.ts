import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env, ToolResult } from "./env";
import { na } from "./env";
import * as Q from "./queue";

const INSTRUCTIONS = `Muse bridge: a job-application work queue supervised by a guardian.
Always begin with start_session, then follow next_action in every response. Never improvise tool order.`;

// Loose schemas on purpose: validation happens inside handlers so EVERY error still carries next_action.
const s = z.string().optional();
const id = z.union([z.number(), z.string()]).optional();
const lease = { worker_id: s, job_id: id, lease_token: s };

function wrap(fn: (args: any) => Promise<ToolResult>) {
  return async (args: any) => {
    let out: ToolResult;
    try {
      out = await fn(args ?? {});
    } catch (e) {
      console.error("tool error", (e as Error)?.message);
      out = {
        ok: false,
        error: "internal_error",
        message: "The bridge hit an internal error. Retry once; if it repeats, get the next job.",
        next_action: args?.worker_id ? na("get_next_job", { worker_id: args.worker_id }, "Recover.") : na("start_session", {}, "Recover."),
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(out) }], isError: out.ok === false ? true : undefined };
  };
}

export function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "muse-bridge", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "start_session",
    { description: "Call FIRST. Returns your worker_id, standing orders, the applicant profile, and next_action.", inputSchema: z.object({}) },
    wrap(() => Q.startSession(env)),
  );
  server.registerTool(
    "get_next_job",
    { description: "Lease the next internship application to work on (or get back the one you hold).", inputSchema: z.object({ worker_id: s }) },
    wrap((a) => Q.getNextJob(env, String(a.worker_id ?? ""))),
  );
  server.registerTool(
    "lookup_answer",
    {
      description: "Look up a stored answer for a form field (work authorization, sponsorship, start date, demographics, links...). Call before ask_guardian.",
      inputSchema: z.object({ ...lease, question: s, options: z.array(z.string()).optional() }),
    },
    wrap((a) => Q.lookupAnswer(env, a)),
  );
  server.registerTool(
    "ask_guardian",
    {
      description: "Ask the guardian a question you cannot answer. kind: choice | freeform | approval | verification_code | other. Returns question_id immediately.",
      inputSchema: z.object({ ...lease, question: s, kind: s, options: z.array(z.string()).optional(), context: s }),
    },
    wrap((a) => Q.askGuardian(env, a)),
  );
  server.registerTool(
    "get_answer",
    { description: "Check whether the guardian answered a question.", inputSchema: z.object({ ...lease, question_id: id }) },
    wrap((a) => Q.getAnswer(env, a)),
  );
  server.registerTool(
    "wait_for_code",
    { description: "Wait (up to ~20s per call) for the guardian to supply an emailed verification code or link.", inputSchema: z.object({ ...lease, question_id: id }) },
    wrap((a) => Q.waitForCode(env, a)),
  );
  server.registerTool(
    "request_essay",
    {
      description: "Request a tailored essay / long answer for this company from the guardian. Pass the exact prompt and any word limit.",
      inputSchema: z.object({ ...lease, prompt: s, word_limit: id, context: s }),
    },
    wrap((a) => Q.requestEssay(env, a)),
  );
  server.registerTool(
    "get_or_create_credential",
    { description: "Get the email + password to use for this job's application portal (creates and remembers a new one if needed).", inputSchema: z.object(lease) },
    wrap((a) => Q.getOrCreateCredential(env, a)),
  );
  server.registerTool(
    "begin_submit",
    { description: "Call immediately BEFORE clicking the final Submit button.", inputSchema: z.object(lease) },
    wrap((a) => Q.beginSubmit(env, a)),
  );
  server.registerTool(
    "report_result",
    {
      description: "Report the outcome for the job you hold. status: submitted | failed | skipped | needs_human.",
      inputSchema: z.object({ ...lease, status: s, notes: s, confirmation: s }),
    },
    wrap((a) => Q.reportResult(env, a)),
  );
  server.registerTool(
    "defer_job",
    {
      description: "Park the job you hold while waiting on the guardian (pass the question ids you are waiting on). It is handed back first once answered.",
      inputSchema: z.object({ ...lease, blocking_question_ids: z.array(z.union([z.number(), z.string()])).optional(), reason: s }),
    },
    wrap((a) => Q.deferJob(env, a)),
  );
  server.registerTool(
    "heartbeat",
    { description: "Extend your lease while working on a long application.", inputSchema: z.object(lease) },
    wrap((a) => Q.heartbeat(env, a)),
  );
  server.registerTool(
    "get_stats",
    { description: "Progress counts by status.", inputSchema: z.object({ worker_id: s }) },
    wrap((a) => Q.getStats(env, a.worker_id)),
  );
  return server;
}
