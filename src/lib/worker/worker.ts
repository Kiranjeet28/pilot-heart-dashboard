// Typed boundary for desktop workers. The dashboard talks ONLY to this interface.
// Milestone 2 extends it compatibly: new members are optional so the mock keeps working.
import type { ValidatedActionRequest } from "./action-validation";

export type WorkerMode = "demo" | "live";
export type WorkerConnection = "connected" | "disconnected" | "error" | "busy" | "pairing";

export interface WorkerStatus {
  mode: WorkerMode;
  connection: WorkerConnection;
  workerVersion?: string;
  message: string;
  screen?: { width: number; height: number } | undefined;
  stopped?: boolean;
}

export interface WorkerHealth {
  ok: boolean;
  latencyMs: number;
  checkedAt: number;
  message: string;
}

export interface ObservationRequest {
  taskId: string;
  targetId: string;
  targetLabel: string;
  note?: string;
}

export interface ObservationResult {
  imageDataUrl: string;
  capturedAt: number;
  simulated: boolean;
  width?: number;
  height?: number;
  observationId?: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  simulated: boolean;
  completedAt: number;
  data?: {
    clipboardLength?: number;
    typedLength?: number;
    clipboardSha256Prefix?: string;
  };
}

export interface WorkerCapabilities {
  actions: string[];
  keys: string[];
  limits: Record<string, number>;
  uiAutomation: boolean;
}

export interface DesktopWorker {
  readonly mode: WorkerMode;
  getStatus(): Promise<WorkerStatus>;
  healthCheck(): Promise<WorkerHealth>;
  observe(req: ObservationRequest): Promise<ObservationResult>;
  executeAction(taskId: string, action: ValidatedActionRequest): Promise<ActionResult>;
  cancelTask(taskId: string): Promise<void>;
  // ---- optional (Milestone 2) ----
  getCapabilities?(): Promise<WorkerCapabilities>;
  /** Stop accepting actions and interrupt the current one. */
  stop?(): Promise<void>;
  resume?(): Promise<void>;
}

export class WorkerUnavailableError extends Error {}
