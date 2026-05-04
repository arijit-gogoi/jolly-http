import { parseShorthand } from "./shorthand.js"
import { performRequest } from "./request.js"
import { runWorkflowFn } from "./run.js"
import { formatResponse, shouldUseColor } from "./output.js"
import type { AdhocOptions, RunResult, WorkflowFn } from "./types.js"

/**
 * Build a one-line workflow from ad-hoc CLI args (METHOD, url, body shorthand)
 * and invoke runWorkflow with it. The printed response goes to stdout unless
 * quiet is set. Return value is the RunResult for exit-code decisions.
 */
export async function runAdhoc(opts: AdhocOptions): Promise<RunResult> {
  const parsed = parseShorthand(opts.shorthand)

  const headers: Record<string, string> = { ...parsed.headers, ...(opts.headers ?? {}) }
  const query = parsed.query
  let body: { json?: unknown; form?: Record<string, string>; body?: string } = {}
  if (opts.jsonBody !== undefined) {
    body = { json: JSON.parse(opts.jsonBody) }
  } else if (opts.formMode) {
    body = { form: parsed.formBody }
  } else if (parsed.hasJson) {
    body = { json: parsed.jsonBody }
  }

  const workflow: WorkflowFn = async () => {
    const res = await performRequest(opts.method, opts.url, {
      headers,
      query,
      ...body,
    })
    if (!opts.quiet) {
      const out = await formatResponse(res, shouldUseColor())
      process.stdout.write(out + "\n")
    }
    return { status: res.status }
  }

  return runWorkflowFn(workflow, {
    workflowPath: "<adhoc>",
    outPath: opts.outPath,
    perRequestTimeoutMs: opts.perRequestTimeoutMs,
    userAgent: opts.userAgent,
    insecure: opts.insecure,
    quiet: opts.quiet,
    signal: opts.signal,
    cookiesDir: opts.cookiesDir,
    cookiesResumeDir: opts.cookiesResumeDir,
    harDir: opts.harDir,
    harReplayPath: opts.harReplayPath,
    envFiles: opts.envFiles,
    noEnvFile: opts.noEnvFile,
    requireEnvPath: opts.requireEnvPath,
  })
}
