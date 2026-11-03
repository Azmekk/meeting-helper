// Settings → MCP: connecting Claude Code and Codex to the app's MCP server.
// The server itself is in Rust (mcp.rs); see mcp_connect.rs for these commands.
import { invoke } from '@tauri-apps/api/core';

export type McpClient = 'claude' | 'codex';

export interface McpStatus {
  serverPath: string;
  claude: { installed: boolean; connected: boolean };
  codex: { installed: boolean; connected: boolean };
}

export const getMcpStatus = () => invoke<McpStatus>('mcp_status');
export const connectMcp = (client: McpClient) => invoke<void>('mcp_connect', { client });
export const disconnectMcp = (client: McpClient) => invoke<void>('mcp_disconnect', { client });
export const testMcp = () => invoke<number>('mcp_test');
export const openMcpTerminal = (client: McpClient) => invoke<void>('mcp_open_terminal', { client });

// The command to connect by hand; quotes keep paths with spaces in one piece.
export function mcpConnectCommand(client: McpClient, serverPath: string): string {
  const scope = client === 'claude' ? ' --scope user' : '';
  return `${client} mcp add${scope} meeting-helper -- "${serverPath}" --mcp`;
}

// meeting-helper://meeting/12?t=75000&seg=345 → the route it opens, or null.
export function linkToRoute(url: string): string | null {
  const m = /^meeting-helper:\/\/(meeting|folder)\/(\d+)\/?(?:\?(.*))?$/.exec(url.trim());
  if (!m) return null;
  if (m[1] === 'folder') return `/folders/${m[2]}`;
  const given = new URLSearchParams(m[3] ?? '');
  const params = new URLSearchParams();
  for (const key of ['t', 'seg']) {
    const value = given.get(key);
    if (value && /^\d+$/.test(value)) params.set(key, value);
  }
  const query = params.toString();
  return `/meetings/${m[2]}${query ? `?${query}` : ''}`;
}
