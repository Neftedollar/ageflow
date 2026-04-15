import { defineWorkflow, loop, sessionToken, registerRunner } from "@agentflow/core";
import { ClaudeRunner } from "@agentflow/runner-claude";
import { analyzeAgent } from "./agents/analyze.js";
import { fixAgent } from "./agents/fix.js";
import { evalAgent } from "./agents/eval.js";
import { summarizeAgent } from "./agents/summarize.js";

// Register runner (top-level side effect — runs when file is imported)
registerRunner("claude", new ClaudeRunner());

// Session: fix and eval share context across loop iterations
const fixSession = sessionToken("fix-context", "claude");

type IssueShape = {
  id: string;
  file: string;
  description: string;
  severity: "high" | "medium" | "low";
};

// Inner loop: fix → eval, repeats until eval says satisfied or max 3 iterations
const fixLoop = loop({
  dependsOn: ["analyze"],
  max: 3,
  context: "persistent",
  until: (ctx: unknown) => {
    const c = ctx as Record<string, { output: unknown }>;
    const evalOut = c["eval"]?.output as { satisfied?: boolean } | undefined;
    return evalOut?.satisfied === true;
  },
  input: (ctx: unknown) => {
    const c = ctx as Record<string, { output: unknown }>;
    const analyzeOut = c["analyze"]?.output as { issues?: IssueShape[] } | undefined;
    const issue = analyzeOut?.issues?.[0] ?? {
      id: "none",
      file: "unknown",
      description: "no issues found",
      severity: "low" as const,
    };
    return { issue };
  },
  tasks: {
    fix: {
      agent: fixAgent,
      session: fixSession,
      input: (_ctx: unknown) => ({
        issue: { id: "i1", file: "src/app.ts", description: "Null pointer", severity: "high" as const },
      }),
    },
    eval: {
      agent: evalAgent,
      dependsOn: ["fix"],
      session: fixSession,
      input: (ctx: unknown) => {
        const c = ctx as Record<string, { output: unknown }>;
        const fixOut = c["fix"]?.output as { patch?: string; explanation?: string } | undefined;
        return {
          issue: { id: "i1", file: "src/app.ts", description: "Null pointer", severity: "high" as const },
          patch: fixOut?.patch ?? "",
          explanation: fixOut?.explanation ?? "",
        };
      },
    },
  },
});

export default defineWorkflow({
  name: "bug-fix-pipeline",
  tasks: {
    analyze: {
      agent: analyzeAgent,
      input: { repoPath: "./src", focus: "security and null safety" },
    },
    fixLoop,
    summarize: {
      agent: summarizeAgent,
      dependsOn: ["analyze", "fixLoop"],
      input: (ctx: Record<string, { output: unknown; _source: string }>) => {
        const analyzeOut = ctx["analyze"]?.output as { issues?: IssueShape[] } | undefined;
        return {
          originalIssues: analyzeOut?.issues ?? [],
          fixResult: ctx["fixLoop"]?.output,
        };
      },
    },
  },
});
