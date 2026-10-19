// Example configuration. Contains NO secrets — credentialRef values are names of secrets stored elsewhere.
import type { AccountProfile, AppSettings, DesktopTarget, Provider } from "@/lib/types";

export const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: "qwen",
    displayName: "Local Qwen",
    type: "custom",
    connectionMethod: "local_endpoint",
    model: "qwen",
    enabled: true,
    connectionStatus: "configured_unverified",
  },
  {
    id: "gemini",
    displayName: "Google Gemini",
    type: "gemini",
    connectionMethod: "api_key",
    model: "gemini-3.8-flash",
    enabled: true,
    connectionStatus: "configured_unverified",
  },
  {
    id: "grok",
    displayName: "Grok (xAI)",
    type: "grok",
    connectionMethod: "api_key",
    model: "grok-4.7",
    enabled: true,
    connectionStatus: "configured_unverified",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    type: "openai",
    connectionMethod: "api_key",
    model: "gpt-5",
    enabled: false,
    connectionStatus: "not_configured",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    type: "anthropic",
    connectionMethod: "api_key",
    model: "claude-sonnet-4",
    enabled: false,
    connectionStatus: "not_configured",
  },
];

export const DEFAULT_PROFILES: AccountProfile[] = [
  {
    id: "personal",
    name: "Personal",
    providerId: "qwen",
    authMethod: "none",
    credentialRef: "",
    notes: "Local model",
  },
  {
    id: "work",
    name: "Work",
    providerId: "qwen",
    authMethod: "none",
    credentialRef: "",
    notes: "Local model",
  },
  {
    id: "gemini-server-key",
    name: "Gemini API key (server environment)",
    providerId: "gemini",
    authMethod: "api_key_ref",
    credentialRef: "GEMINI_API_KEY",
    notes: "Key is read by the server from the environment and is not stored in browser profile data.",
  },
  {
    id: "grok-server-key",
    name: "Grok API key (server environment)",
    providerId: "grok",
    authMethod: "api_key_ref",
    credentialRef: "XAI_API_KEY",
    notes: "Key is read by the server from the environment and is not stored in browser profile data.",
  },
];

export const DEFAULT_TARGETS: DesktopTarget[] = [
  {
    id: "vscode",
    displayName: "Visual Studio Code",
    kind: "vscode",
    launchPath: "",
    windowTitleContains: "Visual Studio Code",
    processName: "Code.exe",
    interactionMode: "assisted",
  },
  {
    id: "cursor",
    displayName: "Cursor",
    kind: "cursor",
    launchPath: "",
    windowTitleContains: "Cursor",
    processName: "Cursor.exe",
    interactionMode: "assisted",
  },
  {
    id: "browser-chat",
    displayName: "Browser AI chat",
    kind: "browser_chat",
    launchPath: "",
    windowTitleContains: "Chat",
    processName: "msedge.exe",
    interactionMode: "observe_only",
  },
  {
    id: "desktop",
    displayName: "Windows Desktop",
    kind: "custom",
    launchPath: "",
    windowTitleContains: "",
    processName: "",
    interactionMode: "assisted",
  },
];

export const DEFAULT_SETTINGS: AppSettings = {
  workerPort: 8765,
  adaptiveChecks: true,
  aiMode: "local",
  localBaseUrl: "http://127.0.0.1:8081",
};
