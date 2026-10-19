import type { ValidatedActionRequest } from "@/lib/worker/action-validation";
import type { ActionResult, DesktopWorker, ObservationRequest, ObservationResult, WorkerHealth, WorkerStatus } from "@/lib/worker/worker";
import { WorkerUnavailableError } from "@/lib/worker/worker";

export interface MockWorkerOptions { isConnected: () => boolean; failureRate: () => number; random?: () => number }

/** Test-only fake. The app never imports this worker or selects it at runtime. */
export class MockDesktopWorker implements DesktopWorker {
  readonly mode = "live" as const;
  private cancelled = new Set<string>();
  constructor(private readonly options: MockWorkerOptions) {}
  private ensure() { if (!this.options.isConnected()) throw new WorkerUnavailableError("Test worker is disconnected"); }
  async getStatus(): Promise<WorkerStatus> {
    const connected = this.options.isConnected();
    return { mode: "live", connection: connected ? "connected" : "disconnected", workerVersion: "test-fake", message: connected ? "Test fake is available" : "Test fake is disconnected" };
  }
  async healthCheck(): Promise<WorkerHealth> {
    const ok = this.options.isConnected();
    return { ok, latencyMs: ok ? 1 : 0, checkedAt: Date.now(), message: ok ? "Test fake available" : "Test fake unavailable" };
  }
  async observe(_request: ObservationRequest): Promise<ObservationResult> {
    this.ensure();
    return { imageDataUrl: "data:image/png;base64,dGVzdA==", capturedAt: Date.now(), simulated: true, width: 1, height: 1 };
  }
  async executeAction(taskId: string, _action: ValidatedActionRequest): Promise<ActionResult> {
    this.ensure();
    const failed = (this.options.random ?? Math.random)() < this.options.failureRate();
    return { ok: !this.cancelled.has(taskId) && !failed, message: failed ? "Test fake failure" : "Test fake action", simulated: true, completedAt: Date.now() };
  }
  async cancelTask(taskId: string) { this.cancelled.add(taskId); }
}
