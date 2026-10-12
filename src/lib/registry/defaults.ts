// Example configuration. Contains NO secrets — credentialRef values are names of secrets stored elsewhere.
import type { AccountProfile, AppSettings, DesktopTarget, Provider } from "@/lib/types";

export const DEFAULT_PROVIDERS: Provider[] = [
  { id: "openai", displayName: "OpenAI", type: "openai", connectionMethod: "api_key", model: "gpt-5", enabled: true, connectionStatus: "configured_unverified" },
  { id: "gemini", displayName: "Google Gemini", type: "gemini", connectionMethod: "api_key", model: "gemini-2.5-pro", enabled: true, connectionStatus: "configured_unverified" },
  { id: "anthropic", displayName: "Anthropic", type: "anthropic", connectionMethod: "api_key", model: "claude-sonnet-4", enabled: false, connectionStatus: "not_configured" },
  { id: "custom-local", displayName: "Custom (local endpoint)", type: "custom", connectionMethod: "local_endpoint", model: "", enabled: false, connectionStatus: "not_configured" },
];

export const DEFAULT_PROFILES: AccountProfile[] = [
  { id: "personal", name: "Personal", providerId: "openai", authMethod: "api_key_ref", credentialRef: "OPENAI_PERSONAL_KEY", notes: "" },
  { id: "work", name: "Work", providerId: "gemini", authMethod: "api_key_ref", credentialRef: "GEMINI_WORK_KEY", notes: "" },
];

export const DEFAULT_TARGETS: DesktopTarget[] = [
  { id: "vscode", displayName: "Visual Studio Code", kind: "vscode", launchPath: "", windowTitleContains: "Visual Studio Code", processName: "Code.exe", interactionMode: "assisted" },
  { id: "cursor", displayName: "Cursor", kind: "cursor", launchPath: "", windowTitleContains: "Cursor", processName: "Cursor.exe", interactionMode: "assisted" },
  { id: "browser-chat", displayName: "Browser AI chat", kind: "browser_chat", launchPath: "", windowTitleContains: "Chat", processName: "msedge.exe", interactionMode: "observe_only" },
];

export const DEFAULT_SETTINGS: AppSettings = { workerSimulation: "connected", failureRate: 0.1, stepDelayMs: 1200 };
