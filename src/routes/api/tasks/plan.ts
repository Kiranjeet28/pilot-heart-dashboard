import { createFileRoute } from "@tanstack/react-router";
import { handleTaskPlanRequest } from "@/lib/server/task-plan";

/**
 * POST /api/tasks/plan — Local Qwen task planning (Module 3).
 *
 * App-internal endpoint (not under /api/public): the handler authenticates the
 * caller itself — same-origin browser requests, or a Bearer server token for
 * internal clients. Calls local llama-server running model alias "qwen".
 */
export const Route = createFileRoute("/api/tasks/plan")({
  server: {
    handlers: {
      POST: async ({ request }) => handleTaskPlanRequest(request),
    },
  },
});
