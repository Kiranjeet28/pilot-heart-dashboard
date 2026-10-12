// Typed boundary for the future local Windows worker. The dashboard talks ONLY to this interface.
import type { ValidatedActionRequest } from "./action-validation";

export type WorkerMode = "demo" | "live";
export type WorkerConnection = "connected" | "disconnected" | "error";

export interface WorkerStatus {
  mode: WorkerMode;
  connection: WorkerConnection;
  workerVersion?: string;
  message: string;
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
}

export interface ActionResult {
  ok: boolean;
  message: string;
  simulated: boolean;
  completedAt: number;
}

export interface DesktopWorker {
  readonly mode: WorkerMode;
  getStatus(): Promise<WorkerStatus>;
  healthCheck(): Promise<WorkerHealth>;
  observe(req: ObservationRequest): Promise<ObservationResult>;
  executeAction(taskId: string, action: ValidatedActionRequest): Promise<ActionResult>;
  cancelTask(taskId: string): Promise<void>;
}

export class WorkerUnavailableError extends Error {}
