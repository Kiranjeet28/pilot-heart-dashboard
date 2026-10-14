import { describe, expect, it } from "vitest";
import { computeStats, dailySeries } from "@/lib/dashboard-stats";
import { searchPrompts, type SavedPrompt } from "@/lib/prompts";
import { clampMinutes, clampRetries } from "@/store/app-store";
import type { Task, TaskStatus } from "@/lib/types";

const task = (status: TaskStatus, createdAt = Date.now()): Task => ({
  id: Math.random().toString(),
  description: "x",
  providerId: "p",
  profileId: "pr",
  targetId: "t",
  status,
  createdAt,
  progress: 0,
  steps: [],
  currentStep: 0,
  retries: 0,
});

describe("dashboard stats", () => {
  it("ignores drafts and computes success rate from finished tasks", () => {
    const s = computeStats([
      task("draft"),
      task("completed"),
      task("completed"),
      task("completed"),
      task("failed"),
      task("running"),
      task("cancelled"),
    ]);
    expect(s).toEqual({ total: 6, running: 1, completed: 3, failed: 1, successRate: 75 });
  });

  it("has no success rate before any task finished", () => {
    expect(computeStats([task("running")]).successRate).toBeNull();
  });

  it("buckets the last 7 days oldest first", () => {
    const now = new Date(2026, 9, 14, 12).getTime();
    const s = dailySeries([task("completed", now), task("failed", now - 86_400_000 * 10)], 7, now);
    expect(s).toHaveLength(7);
    expect(s[6]!.completed).toBe(1);
    expect(s.reduce((a, d) => a + d.failed, 0)).toBe(0);
  });
});

describe("prompt workspace", () => {
  it("searches title, prompt and context case-insensitively", () => {
    const list: SavedPrompt[] = [
      { id: "1", title: "Open VS Code", prompt: "Open VS Code", context: "", createdAt: 1 },
      { id: "2", title: "Browser", prompt: "Open the browser", context: "my Website", createdAt: 2 },
    ];
    expect(searchPrompts(list, "website").map((p) => p.id)).toEqual(["2"]);
    expect(searchPrompts(list, "  ")).toHaveLength(2);
  });

  it("clamps time limit to 1-30 minutes (default 10) and retries to 0-2 (default 2)", () => {
    expect(clampMinutes(undefined)).toBe(10);
    expect(clampMinutes(0)).toBe(1);
    expect(clampMinutes(120)).toBe(30);
    expect(clampRetries(undefined)).toBe(2);
    expect(clampRetries(5)).toBe(2);
    expect(clampRetries(-1)).toBe(0);
  });
});
