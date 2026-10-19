import { Link, useRouterState } from "@tanstack/react-router";
import { OctagonX, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { actions, useAppState } from "@/store/app-store";
import { Button } from "@/components/ui/button";

export function AppHeader() {
  const path = useRouterState({ select: (router) => router.location.pathname });
  const connection = useAppState((state) => state.connection);
  const emergencyStop = useAppState((state) => state.emergencyStop);

  return (
    <header className="sticky top-0 z-20 flex min-h-14 items-center gap-4 border-b bg-background/95 px-4 backdrop-blur">
      <Link to="/" className="font-semibold tracking-tight text-foreground">
        DesktopPilot
      </Link>
      <nav aria-label="Main navigation" className="flex h-14 items-stretch gap-1">
        <Link
          to="/"
          aria-current={path === "/" ? "page" : undefined}
          className={`inline-flex items-center border-b-2 px-3 text-sm ${path === "/" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          Main
        </Link>
        <Link
          to="/settings"
          aria-current={path === "/settings" ? "page" : undefined}
          className={`inline-flex items-center border-b-2 px-3 text-sm ${path === "/settings" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          Settings
        </Link>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <span
          className={`hidden rounded border px-2 py-1 font-mono text-[11px] sm:inline-flex ${connection.state === "connected" && !connection.stopped ? "border-success/40 text-success" : "border-warning/40 text-warning"}`}
          role="status"
        >
          Worker: {connection.stopped ? "stopped" : connection.state}
        </span>
        {emergencyStop ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              actions.resetEmergencyStop();
              toast.success("Emergency Stop reset");
            }}
          >
            <RotateCcw className="h-4 w-4" /> Reset Stop
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="destructive"
          disabled={emergencyStop}
          onClick={() => {
            actions.emergencyStop();
            toast.error("Emergency Stop engaged; active tasks were halted");
          }}
        >
          <OctagonX className="h-4 w-4" /> Emergency Stop
        </Button>
      </div>
    </header>
  );
}
