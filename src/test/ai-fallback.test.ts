import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GEMINI_COOLDOWN_MS,
  OFFLINE_MESSAGE,
  __resetAiStatus,
  aiStatus,
  configureAiRouting,
  cooldownFor,
  runWithFallback,
  type AiMode,
} from "@/lib/ai/aiProvider";
import { DEFAULT_PROVIDERS } from "@/lib/registry/defaults";

const plan = {
  plan: ["Look"],
  summary: "ok",
  steps: [{ action: { kind: "read_screen", targetId: "notepad", description: "Look" }, requiresApproval: false }],
};
const sse = (text: string, chunk = 20) => {
  let body = "";
  for (let i = 0; i < text.length; i += chunk)
    body += `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + chunk) } }] })}\n\n`;
  return new Response(body + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
};
const req = { userRequest: "Open Notepad", targetId: "notepad", provider: DEFAULT_PROVIDERS[0]! };

let mode: AiMode = "auto";
let gemini: () => Response;
let localUp = true;
const calls: string[] = [];

beforeEach(() => {
  __resetAiStatus();
  mode = "auto";
  localUp = true;
  calls.length = 0;
  gemini = () => Response.json(plan);
  configureAiRouting(() => ({ mode, localBaseUrl: "http://127.0.0.1:8081" }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/tasks/plan") return gemini();
      if (url.endsWith("/health")) {
        if (!localUp) throw new TypeError("Failed to fetch");
        return Response.json({ status: "ok" });
      }
      if (url.endsWith("/v1/chat/completions")) return sse(JSON.stringify(plan));
      return new Response("no", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const localCalls = () => calls.filter((c) => c.endsWith("/v1/chat/completions")).length;
const geminiCalls = () => calls.filter((c) => c === "/api/tasks/plan").length;

describe("runWithFallback", () => {
  it("uses Gemini when it works", async () => {
    const r = await runWithFallback(req);
    expect(r.ok).toBe(true);
    expect(localCalls()).toBe(0);
  });

  it("falls back to the local model on a Gemini 429", async () => {
    gemini = () => Response.json({ message: "quota" }, { status: 429 });
    const r = await runWithFallback(req);
    expect(r.ok).toBe(true);
    expect(localCalls()).toBe(1);
    expect(aiStatus.get().active).toBe("local");
  });

  it("skips Gemini during the cooldown", async () => {
    gemini = () => Response.json({ message: "down" }, { status: 503 });
    await runWithFallback(req);
    const before = geminiCalls();
    await runWithFallback(req);
    expect(geminiCalls()).toBe(before);
  });

  it("returns the offline message when the local model is down", async () => {
    gemini = () => Response.json({ message: "down" }, { status: 503 });
    localUp = false;
    const r = await runWithFallback(req);
    expect(!r.ok && r.message).toContain(OFFLINE_MESSAGE);
    expect(!r.ok && r.message).toContain("Gemini failed: ");
    expect(aiStatus.get().active).toBe("offline");
  });

  it("never uses the local model in Gemini-only mode", async () => {
    mode = "gemini";
    gemini = () => Response.json({ message: "quota" }, { status: 429 });
    expect((await runWithFallback(req)).ok).toBe(false);
    expect(localCalls()).toBe(0);
  });

  it("never calls Gemini in local-only mode", async () => {
    mode = "local";
    expect((await runWithFallback(req)).ok).toBe(true);
    expect(geminiCalls()).toBe(0);
  });

  it("does not fall back when the user cancelled", async () => {
    gemini = () => Response.json({ message: "down" }, { status: 503 });
    const c = new AbortController();
    c.abort();
    await runWithFallback(req, c.signal);
    expect(localCalls()).toBe(0);
  });
});

describe("cooldown", () => {
  it("defaults to 5 minutes", () => {
    expect(cooldownFor("server error")).toBe(GEMINI_COOLDOWN_MS);
    expect(GEMINI_COOLDOWN_MS).toBe(300_000);
  });
  it("follows Google's retry hint", () => {
    expect(cooldownFor("Please retry in 58.03s.")).toBe(59_000);
  });
});
