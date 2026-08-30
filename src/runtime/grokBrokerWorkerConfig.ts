import path from "node:path";

export function renderGrokBrokerWorkerConfig(helperPath: string, proxyPort: number): string {
  if (!path.posix.isAbsolute(helperPath) || /[\r\n"']/u.test(helperPath) || !Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65_535) throw new TypeError("invalid Grok broker worker configuration");
  return [
    "[cli]", "auto_update = false", "use_leader = false", "",
    "[features]", "telemetry = false", "",
    "[auth_provider.daimon]", `command = ${JSON.stringify(helperPath)}`, 'args = ["--auth-provider"]', "timeout_secs = 5", "token_ttl_secs = 600", "",
    "[model.daimon-broker-grok]", 'model = "grok-build"', `base_url = "http://127.0.0.1:${proxyPort}/v1"`, 'auth_provider = "daimon"', "context_window = 131072", "supports_backend_search = false", "",
    "[mcp_servers.daimon]", 'url = "http://127.0.0.1:43124/mcp"', 'headers = { Authorization = "Bearer ${DAIMON_MCP_CAPABILITY}" }', ""
  ].join("\n");
}

export const renderGrokBrokerWorkerArgs = (promptFile: string, cwd: string): readonly string[] => {
  if (!path.posix.isAbsolute(promptFile) || !path.posix.isAbsolute(cwd)) throw new TypeError("invalid Grok broker worker path");
  return ["--sandbox", "daimon-strict", "--always-approve", "--no-subagents", "--prompt-file", promptFile, "--no-memory", "--disable-web-search", "--cwd", cwd, "--output-format", "streaming-messages-json", "--model", "daimon-broker-grok"];
};
