// Core domain types for DesktopPilot. Shared by UI, store, and worker boundary.

export type ProviderType = "openai" | "gemini" | "anthropic" | "custom";
export type ConnectionMethod = "api_key" | "oauth" | "local_endpoint" | "browser_session";
/** Never "connected" until a real integration is implemented and verified. */
export type ProviderConnectionStatus = "not_configured" | "configured_unverified" | "error";

export interface Provider {
  id: string;
  displayName: string;
  type: ProviderType;
  connectionMethod: ConnectionMethod;
  model: string;
  enabled: boolean;
  connectionStatus: ProviderConnectionStatus;
}

export type AuthMethod = "api_key_ref" | "oauth_ref" | "session_ref" | "none";

/** Safe metadata only. `credentialRef` is the NAME of a secret held elsewhere, never the secret. */
export interface AccountProfile {
  id: string;
  name: string;
  providerId: string;
  authMethod: AuthMethod;
  credentialRef: string;
  notes: string;
}

export type TargetKind = "vscode" | "cursor" | "browser_chat" | "custom";
export type InteractionMode = "observe_only" | "assisted" | "autonomous";

export interface DesktopTarget {
  id: string;
  displayName: string;
  kind: TargetKind;
  launchPath: string; // optional, user-configured; never launched from the web dashboard
  windowTitleContains: string;
  processName: string;
  interactionMode: InteractionMode;
}

export type TaskStatus =
  | "draft"
  | "queued"
  | "planning"
  | "running"
  | "waiting_for_approval"
  | "awaiting_approval"
  | "awaiting_input"
  | "verifying"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type ActionKind =
  | "focus_window"
  | "read_screen"
  | "click"
  | "type_text"
  | "key_press"
  | "wait"
  | "copy_selection"
  | "paste";

export interface ActionRequest {
  kind: ActionKind;
  targetId: string;
  description: string;
  text?: string;
  x?: number;
  y?: number;
  keys?: string;
  durationMs?: number;
  /** Required by the real worker for coordinate actions (fresh observation). */
  observationId?: string;
}

export interface PlannedStep {
  id: string;
  action: ActionRequest;
  requiresApproval: boolean;
  approved?: boolean;
  done?: boolean;
  verification?: VerificationSpec;
}

export type VerificationKind = "worker_ok" | "screen_capture" | "text_match" | "clipboard";

export interface VerificationSpec {
  kind: VerificationKind;
  expectedText?: string;
  allowPartial?: boolean;
}

export type ActivityKind =
  "info" | "action" | "result" | "warning" | "error" | "approval" | "safety";

export interface ActivityEvent {
  id: string;
  taskId: string | null;
  timestamp: number;
  kind: ActivityKind;
  message: string;
  /** True when produced by the mock worker / demo planner — never a real desktop action. */
  simulated: boolean;
  /** True only for actions executed by the REAL local Windows worker. */
  real?: boolean;
}

export interface VerificationState {
  status: "pending" | "passed" | "failed" | "unverified";
  reason?: string | undefined;
  checkedAt?: number | undefined;
}

export interface Task {
  id: string;
  description: string;
  providerId: string;
  profileId: string;
  targetId: string;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number | undefined;
  updatedAt?: number | undefined;
  progress: number; // 0-100
  steps: PlannedStep[];
  currentStep: number;
  retries: number;
  /** Retry limit per failed step (0-2, default 2). */
  maxRetries?: number;
  /** Optional project context entered in the Prompt Workspace. */
  context?: string;
  replans?: number;
  /** Set once the user approves the plan before it starts; no per-step prompts after. */
  planApproved?: boolean;
  /** Module 4: what the user approved; replanned steps must stay inside it. */
  approvedScope?: {
    targetId: string;
    kinds: ActionKind[];
    keys: string[];
    texts: string[];
  };
  /** Module 4: latest screen check after a step. */
  lastCheck?: {
    verdict: "ok" | "off_track" | "unsure";
    reason: string;
    screenSummary?: string;
    simulated: boolean;
    checkedAt: number;
  };
  deadlineAt?: number;
  summary?: string;
  error?: string;
  lastVerifiedResult?: string;
  verification?: VerificationState;
  currentAction?: ActionRequest | undefined;
  lastObservation?: {
    imageDataUrl: string;
    capturedAt: number;
    simulated: boolean;
    width?: number;
    height?: number;
    observationId?: string;
  };
}

export type WorkerSimulation = "connected" | "disconnected";
/** Which DesktopWorker implementation the dashboard uses. */
export type WorkerSelection = "demo" | "real_local";

export interface AppSettings {
  workerSimulation: WorkerSimulation;
  failureRate: number; // 0-0.5 chance a simulated action fails
  stepDelayMs: number;
  workerMode: WorkerSelection;
  workerPort: number;
  /** Module 4: check the screen after each step and adjust the plan if needed. */
  adaptiveChecks: boolean;
  /** AI routing: auto (Gemini, local fallback), gemini only, or local only. */
  aiMode: "auto" | "gemini" | "local";
  /** Base URL of the local llama.cpp server on the user's PC. */
  localBaseUrl: string;
}
