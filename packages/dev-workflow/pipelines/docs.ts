// Docs pipeline — DRAFT → REVIEW → PUBLISH.
//
// Used for issues labelled `docs` or `content`: API docs, README updates,
// design specs, and CLAUDE.md maintenance.
//
// Sub-PR 2: all three tasks are now real implementations:
//   draft   — defineAgent using engineering-technical-writer role (codex)
//   review  — defineAgent using engineering-code-reviewer role (codex)
//   publish — defineFunction — git add/commit/push + gh pr create

import {
  defineAgent,
  defineFunction,
  defineWorkflowFactory,
} from "@ageflow/core";
import { execa } from "execa";
import { z } from "zod";
import { loadRoleSync } from "../shared/role-loader.js";
import type { WorkflowInput } from "../shared/types.js";

// DRAFT — engineering-technical-writer writes / updates docs from issue body.
// Output schema mirrors the role's declared Output schema section.
const technicalWriterAgent = defineAgent({
  runner: "codex",
  input: z.object({
    issueNumber: z.number().int().positive(),
    issueTitle: z.string(),
    issueBody: z.string(),
    specPath: z.string(),
    worktreePath: z.string(),
  }),
  output: z.object({
    filesChanged: z.array(z.string()),
    summary: z.string(),
    wordCount: z.number().int().nonnegative(),
  }),
  prompt: (input) => {
    const role = loadRoleSync("engineering-technical-writer");
    return [
      role.body,
      "---",
      `Docs issue #${input.issueNumber}: ${input.issueTitle}`,
      input.issueBody,
      "",
      `Spec: ${input.specPath}`,
      `Worktree: ${input.worktreePath}`,
      "",
      "Write or update the relevant .md file(s). Respect the 'Rules' above.",
    ].join("\n");
  },
});

// REVIEW — engineering-code-reviewer checks accuracy, grammar, and scope.
// Gate: APPROVED | NEEDS_WORK.
const reviewerAgent = defineAgent({
  runner: "codex",
  input: z.object({
    issueNumber: z.number().int().positive(),
    filesChanged: z.array(z.string()),
    summary: z.string(),
    worktreePath: z.string(),
  }),
  output: z.object({
    gate: z.enum(["APPROVED", "NEEDS_WORK"]),
    issues: z.array(z.string()),
  }),
  prompt: (input) => {
    const role = loadRoleSync("engineering-code-reviewer");
    return [
      role.body,
      "---",
      `Review docs issue #${input.issueNumber}`,
      `Files changed: ${input.filesChanged.join(", ")}`,
      `Draft summary: ${input.summary}`,
      `Worktree: ${input.worktreePath}`,
      "",
      "Check: accuracy against spec, grammar, markdown validity, minimal scope.",
      "Return APPROVED only if the change is publish-ready.",
      "",
      "## Required output (JSON)",
      "",
      "```json",
      "{",
      '  "gate": "APPROVED" | "NEEDS_WORK",',
      '  "issues": ["<finding>"]',
      "}",
      "```",
      "",
      "Wrap your response in this JSON object exactly. Do not add prose around it.",
    ].join("\n");
  },
});

// PUBLISH — deterministic git + gh. Runs only when gate = APPROVED.
// Reads the current branch from the worktree so it works regardless of
// how the worktree was created (branch name already set by createWorktree).
const publishFn = defineFunction({
  name: "publish",
  input: z.object({
    issueNumber: z.number().int().positive(),
    issueTitle: z.string(),
    worktreePath: z.string(),
    filesChanged: z.array(z.string()),
    summary: z.string(),
    gate: z.enum(["APPROVED", "NEEDS_WORK"]),
  }),
  output: z.object({
    prNumber: z.number().int().positive().nullable(),
    branch: z.string(),
    commit: z.string(),
  }),
  execute: async (input) => {
    if (input.gate !== "APPROVED") {
      throw new Error(`publish blocked: review gate = ${input.gate}`);
    }

    // Read the branch the worktree is already on (set by createWorktree).
    const { stdout: branchRaw } = await execa(
      "git",
      ["branch", "--show-current"],
      { cwd: input.worktreePath },
    );
    const currentBranch = branchRaw.trim();

    // Stage files. Guard against hallucinated paths: skip files that fail.
    for (const file of input.filesChanged) {
      try {
        await execa("git", ["add", "--", file], { cwd: input.worktreePath });
      } catch (err) {
        console.warn(
          `[docs/publish] git add failed for "${file}" — skipping: ${(err as Error).message}`,
        );
      }
    }

    const commitMsg = `docs: #${input.issueNumber} — ${input.summary}\n\nCloses #${input.issueNumber}`;
    await execa("git", ["commit", "-m", commitMsg], {
      cwd: input.worktreePath,
    });

    const { stdout: commitHash } = await execa("git", ["rev-parse", "HEAD"], {
      cwd: input.worktreePath,
    });

    await execa("git", ["push", "-u", "origin", currentBranch], {
      cwd: input.worktreePath,
    });

    const body = `## Summary\n\n${input.summary}\n\nCloses #${input.issueNumber}`;
    const { stdout: prUrl } = await execa(
      "gh",
      [
        "pr",
        "create",
        "--head",
        currentBranch,
        "--title",
        `docs: #${input.issueNumber} — ${input.issueTitle}`,
        "--body",
        body,
      ],
      { cwd: input.worktreePath },
    );

    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    const prNumber = prNumberMatch ? Number(prNumberMatch[1]) : null;

    return { prNumber, branch: currentBranch, commit: commitHash.trim() };
  },
});

export const createDocsPipeline = defineWorkflowFactory(
  (input: WorkflowInput) => ({
    name: "docs-pipeline",
    tasks: {
      // DRAFT — technical-writer writes docs from issue body + spec.
      draft: {
        agent: technicalWriterAgent,
        input: () => ({
          issueNumber: input.issue.number,
          issueTitle: input.issue.title,
          issueBody: input.issue.body,
          specPath: input.specPath,
          worktreePath: input.worktreePath,
        }),
      },

      // REVIEW — code-reviewer checks accuracy, grammar, minimal scope.
      review: {
        agent: reviewerAgent,
        dependsOn: ["draft"] as const,
        input: (ctx: {
          draft: {
            output: { filesChanged: string[]; summary: string };
          };
        }) => ({
          issueNumber: input.issue.number,
          filesChanged: ctx.draft.output.filesChanged,
          summary: ctx.draft.output.summary,
          worktreePath: input.worktreePath,
        }),
      },

      // PUBLISH — git add/commit/push + gh pr create.
      publish: {
        fn: publishFn,
        dependsOn: ["draft", "review"] as const,
        input: (ctx: {
          draft: {
            output: { filesChanged: string[]; summary: string };
          };
          review: { output: { gate: "APPROVED" | "NEEDS_WORK" } };
        }) => ({
          issueNumber: input.issue.number,
          issueTitle: input.issue.title,
          worktreePath: input.worktreePath,
          filesChanged: ctx.draft.output.filesChanged,
          summary: ctx.draft.output.summary,
          gate: ctx.review.output.gate,
        }),
      },
    },
  }),
);
