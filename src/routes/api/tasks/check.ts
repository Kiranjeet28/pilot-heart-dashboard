import { createFileRoute } from "@tanstack/react-router";
import { handleStepCheckRequest } from "@/lib/server/step-check";

/**
 * POST /api/tasks/check — Module 4 screen check after a real step.
 * Same protections as /api/tasks/plan (same-origin or server token, rate limit, size cap).
 * The screenshot is only used for this request; it is never stored or logged.
 */
export const Route = createFileRoute("/api/tasks/check")({
  server: {
    handlers: {
      POST: async ({ request }) => handleStepCheckRequest(request),
    },
  },
});
