// Tests for worktree helpers — verifies that createWorktree and removeWorktree
// call execa with the expected git arguments.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ stdout: "", exitCode: 0 }),
}));

import { execa } from "execa";
import type { Issue } from "../shared/types.js";
import {
  branchName,
  createWorktree,
  removeWorktree,
  worktreePath,
} from "../shared/worktree.js";

const FAKE_ISSUE: Issue = {
  number: 194,
  title: "dogfood dev-workflow",
  body: "Run dev-workflow against ageflow itself.",
  labels: ["feat"],
  state: "open",
  url: "https://github.com/Neftedollar/ageflow/issues/194",
};

const REPO_ROOT = "/repo/ageflow";

beforeEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: mock return value — only stdout matters for these tests
  vi.mocked(execa).mockResolvedValue({ stdout: "master", exitCode: 0 } as any);
});

describe("worktreePath", () => {
  it("returns a sibling-directory path with issue number suffix", () => {
    const path = worktreePath(REPO_ROOT, 194);
    expect(path).toBe("/repo/ageflow-wt-194");
  });
});

describe("branchName", () => {
  it("slugifies the title with feat/ prefix for unlabelled issues", () => {
    const branch = branchName({ number: 1, title: "Hello World!", labels: [] });
    expect(branch).toBe("feat/1-hello-world");
  });

  it("uses feat/ prefix for feat label", () => {
    const branch = branchName(FAKE_ISSUE);
    expect(branch).toMatch(/^feat\/194-/);
  });

  it("uses bug/ prefix for bug label", () => {
    const branch = branchName({ number: 2, title: "Fix it", labels: ["bug"] });
    expect(branch).toMatch(/^bug\/2-/);
  });

  it("truncates branch names longer than 80 chars", () => {
    const longTitle = "a".repeat(100);
    const branch = branchName({ number: 3, title: longTitle, labels: [] });
    expect(branch.length).toBeLessThanOrEqual(80);
  });
});

describe("createWorktree", () => {
  it("calls git worktree add with path, -b, branch, base", async () => {
    const result = await createWorktree(REPO_ROOT, FAKE_ISSUE);

    expect(execa).toHaveBeenCalledWith(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      { cwd: REPO_ROOT },
    );

    const expectedPath = worktreePath(REPO_ROOT, FAKE_ISSUE.number);
    const expectedBranch = branchName(FAKE_ISSUE);

    expect(execa).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", expectedPath, "-b", expectedBranch, "master"],
      { cwd: REPO_ROOT },
    );

    expect(result).toBe(expectedPath);
  });
});

describe("removeWorktree", () => {
  it("calls git worktree remove with --force", async () => {
    await removeWorktree(REPO_ROOT, 194);

    const expectedPath = worktreePath(REPO_ROOT, 194);
    expect(execa).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", expectedPath, "--force"],
      { cwd: REPO_ROOT },
    );
  });
});
