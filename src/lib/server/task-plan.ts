import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import { normalizeProviderResponse } from "@/lib/ai/provider";

export interface TaskPlanRequestInput {
  taskId?: string | undefined;
  userRequest: string;
  targetId?: string | undefined;
  providerId?: string | undefined;
  profileId?: string | undefined;
  context?: string[] | undefined;
  modelOverride?: string | undefined;
  timeoutMs?: number | undefined;
}

const taskPlanRequestSchema = z.object({
  taskId: z.string().min(1).max(128).optional(),
  userRequest: z.string().min(1).max(4000),
  targetId: z.string().min(1).max(128).optional(),
  providerId: z.string().min(1).max(128).optional(),
  profileId: z.string().min(1).max(128).optional(),
  context: z.array(z.string().min(1).max(500)).max(12).optional().default([]),
  modelOverride: z.string().min(1).max(128).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000),
});

function getServerToken(): string | null {
  const token = process.env["DESKTOPPILOT_SERVER_TOKEN"]?.trim();
  return token && token.length > 0 ? token : null;
}

function isSameOriginRequest(request: Request): boolean {
  const url = new URL(request.url);
  const originHeader = request.headers.get("origin");
  const refererHeader = request.headers.get("referer");
  const fetchSite = request.headers.get("sec-fetch-site");

  if (fetchSite === "cross-site") return false;

  for (const candidate of [originHeader, refererHeader]) {
    if (!candidate) continue;
    try {
      const origin = new URL(candidate).origin;
      if (origin !== url.origin) return false;
    } catch {
      return false;
    }
  }

  return true;
}

function isAuthorizedRequest(request: Request): boolean {
  const serverToken = getServerToken();
  const authHeader =
    request.headers.get("authorization") ?? request.headers.get("x-desktoppilot-session");

  if (authHeader) {
    if (!authHeader.startsWith("Bearer ")) return false;
    const provided = authHeader.slice(7).trim();
    if (serverToken && provided === serverToken) return true;
    if (!serverToken && isSameOriginRequest(request)) return true;
    return false;
  }

  if (!serverToken) return isSameOriginRequest(request);
  return isSameOriginRequest(request);
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "{}";
  const block = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const match = block.match(/\{[\s\S]*\}/);
  return match ? match[0] : cleanedFallback(block);
}

function cleanedFallback(raw: string): string {
  const normalized = raw.trim();
  if (!normalized) return "{}";
  if (normalized.startsWith("{") || normalized.startsWith("[")) return normalized;
  return JSON.stringify({ plan: [normalized], summary: normalized.slice(0, 200) });
}

function buildPrompt(input: TaskPlanRequestInput): string {
  const safeRequest = input.userRequest.trim();
  const contextText = input.context?.length
    ? `\nContext:\n${input.context.map((item) => `- ${item}`).join("\n")}`
    : "";
  return [
    "Return only valid JSON with this exact shape:",
    "{",
    '  "plan": ["step 1 description", "step 2 description"],',
    '  "summary": "short summary",',
    '  "steps": [{ "action": { "kind": "read_screen", "targetId": "desktop", "description": "inspect the desktop" }, "requiresApproval": false, "verification": { "kind": "screen_capture" } }]',
    "}",
    "Choose only safe desktop actions from this allowlist: focus_window, read_screen, click, type_text, key_press, wait, copy_selection, paste.",
    `Task: ${safeRequest}${contextText}`,
    "Keep the plan bounded to at most 12 steps and realistic for DesktopPilot. Include verification for every step and avoid unsafe or destructive actions.",
    "The response must be parseable by JSON.parse without commentary or markdown fences.",
  ].join("\n");
}

export async function generateGeminiTaskPlan(input: TaskPlanRequestInput): Promise<unknown> {
  const apiKey = process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"];
  if (!apiKey) {
    throw Object.assign(new Error("Missing GEMINI_API_KEY server environment variable."), {
      code: "missing_credentials",
    });
  }
  const model = input.modelOverride ?? process.env["GEMINI_MODEL"] ?? "gemini-2.5-flash";
  const ai = new GoogleGenAI({ apiKey });
  const timeoutMs = input.timeoutMs ?? 30000;
  const result = await Promise.race([
    ai.models.generateContent({
      model,
      contents: buildPrompt(input),
      config: {
        temperature: 0.2,
        maxOutputTokens: 800,
      },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Gemini request timeout")), timeoutMs),
    ),
  ]);

  const rawText =
    typeof (result as { text?: string }).text === "string"
      ? (result as { text: string }).text
      : String(result ?? "");
  const candidateJson = extractJsonObject(rawText);
  const parsed = JSON.parse(candidateJson);
  return normalizeProviderResponse(parsed);
}

export async function handleTaskPlanRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json(
      { ok: false, code: "invalid_method", message: "POST is required." },
      { status: 405 },
    );
  }

  if (!isAuthorizedRequest(request)) {
    return Response.json(
      { ok: false, code: "unauthorized", message: "Authentication required." },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, code: "invalid_request", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = taskPlanRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        ok: false,
        code: "invalid_request",
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
      },
      { status: 400 },
    );
  }

  try {
    const result = await generateGeminiTaskPlan(parsed.data);
    return Response.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gemini request failed";
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: string }).code)
        : "unknown";
    const status = code === "missing_credentials" ? 500 : 429;
    return Response.json({ ok: false, code, message }, { status });
  }
}
