// DEMO-mode adapter. Simulates responses; performs NO real desktop actions.
import type {
  ActionResult,
  DesktopWorker,
  ObservationRequest,
  ObservationResult,
  WorkerHealth,
  WorkerStatus,
} from "./worker";
import { WorkerUnavailableError } from "./worker";
import type { ValidatedActionRequest } from "./action-validation";

export interface MockWorkerOptions {
  isConnected: () => boolean;
  failureRate: () => number;
  random?: () => number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esc = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

function simulatedScreenshot(label: string, note: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<rect width="640" height="360" fill="#0d1117"/>
<rect x="40" y="30" width="560" height="300" rx="8" fill="#161b22" stroke="#30363d"/>
<rect x="40" y="30" width="560" height="28" rx="8" fill="#21262d"/>
<circle cx="60" cy="44" r="5" fill="#f85149"/><circle cx="78" cy="44" r="5" fill="#d29922"/><circle cx="96" cy="44" r="5" fill="#3fb950"/>
<text x="320" y="48" fill="#8b949e" font-family="monospace" font-size="12" text-anchor="middle">${esc(label)}</text>
${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="64" y="${84 + i * 26}" width="${180 + ((i * 97) % 300)}" height="10" rx="3" fill="#30363d"/>`).join("")}
<text x="64" y="270" fill="#58a6ff" font-family="monospace" font-size="12">${esc(note.slice(0, 70))}</text>
<rect x="150" y="290" width="340" height="26" rx="4" fill="#d29922" opacity="0.15" stroke="#d29922"/>
<text x="320" y="308" fill="#d29922" font-family="monospace" font-size="12" text-anchor="middle">SIMULATED — NOT A REAL DESKTOP</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export class MockDesktopWorker implements DesktopWorker {
  readonly mode = "demo" as const;
  private cancelled = new Set<string>();
  constructor(private opts: MockWorkerOptions) {}
  private rand() {
    return (this.opts.random ?? Math.random)();
  }
  private ensure() {
    if (!this.opts.isConnected())
      throw new WorkerUnavailableError("Mock worker is disconnected (simulated)");
  }

  async getStatus(): Promise<WorkerStatus> {
    const c = this.opts.isConnected();
    return {
      mode: "demo",
      connection: c ? "connected" : "disconnected",
      workerVersion: "mock-0.1",
      message: c
        ? "Demo worker active — actions are simulated"
        : "No worker reachable (simulated disconnect)",
    };
  }

  async healthCheck(): Promise<WorkerHealth> {
    await wait(120);
    const ok = this.opts.isConnected();
    return {
      ok,
      latencyMs: ok ? 20 + Math.round(this.rand() * 40) : 0,
      checkedAt: Date.now(),
      message: ok ? "Mock worker healthy" : "Mock worker unreachable",
    };
  }

  async observe(req: ObservationRequest): Promise<ObservationResult> {
    this.ensure();
    await wait(80);
    return {
      imageDataUrl: simulatedScreenshot(req.targetLabel, req.note ?? ""),
      capturedAt: Date.now(),
      simulated: true,
    };
  }

  async executeAction(taskId: string, action: ValidatedActionRequest): Promise<ActionResult> {
    this.ensure();
    if (this.cancelled.has(taskId))
      return { ok: false, message: "Task was cancelled", simulated: true, completedAt: Date.now() };
    await wait(150);
    const fail = this.rand() < this.opts.failureRate();
    return {
      ok: !fail,
      message: fail
        ? `Simulated failure: ${action.kind} did not complete`
        : `Simulated ${action.kind} completed`,
      simulated: true,
      completedAt: Date.now(),
    };
  }

  async cancelTask(taskId: string) {
    this.cancelled.add(taskId);
  }
}
