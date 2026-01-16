import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SERVER_NAME = 'ignition-mcp';

interface MCPServerConfig {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface MCPConfig {
  mcpServers?: Record<string, MCPServerConfig>;
}

function getMcpConfigPath(): string {
  return path.join(os.homedir(), '.cursor', 'mcp.json');
}

function readMcpConfig(): MCPConfig | null {
  const configPath = getMcpConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);
    return config;
  } catch {
    return null;
  }
}

function writeMcpConfig(config: MCPConfig): boolean {
  const configPath = getMcpConfigPath();
  const configDir = path.dirname(configPath);
  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function autoConfigureOnStart(port: number): { added: boolean; alreadyConfigured: boolean } {
  const expectedUrl = `http://localhost:${port}/sse`;
  let config = readMcpConfig();
  if (!config) {
    config = { mcpServers: {} };
  }
  if (!config.mcpServers) {
    config.mcpServers = {};
  }
  const existing = config.mcpServers[SERVER_NAME];
  if (existing && existing.url === expectedUrl) {
    return { added: false, alreadyConfigured: true };
  }
  if (existing && existing.url !== expectedUrl) {
    config.mcpServers[SERVER_NAME] = { url: expectedUrl };
    const success = writeMcpConfig(config);
    return { added: success, alreadyConfigured: false };
  }
  config.mcpServers[SERVER_NAME] = { url: expectedUrl };
  const success = writeMcpConfig(config);
  return { added: success, alreadyConfigured: false };
}

export async function configureForCursor(port: number): Promise<void> {
  const cursorConfigDir = path.join(os.homedir(), '.cursor');
  const mcpConfigPath = path.join(cursorConfigDir, 'mcp.json');
  try {
    if (!fs.existsSync(cursorConfigDir)) {
      fs.mkdirSync(cursorConfigDir, { recursive: true });
    }
    let config: MCPConfig = { mcpServers: {} };
    if (fs.existsSync(mcpConfigPath)) {
      const existingContent = fs.readFileSync(mcpConfigPath, 'utf-8');
      try {
        config = JSON.parse(existingContent);
        if (!config.mcpServers) {
          config.mcpServers = {};
        }
      } catch (parseError) {
        const overwrite = await vscode.window.showWarningMessage(
          'Existing mcp.json is invalid. Overwrite?',
          'Overwrite',
          'Cancel'
        );
        if (overwrite !== 'Overwrite') {
          return;
        }
        config = { mcpServers: {} };
      }
    }
    const existingServer = config.mcpServers![SERVER_NAME];
    if (existingServer) {
      const update = await vscode.window.showWarningMessage(
        `Server "${SERVER_NAME}" already exists in mcp.json. Update it?`,
        'Update',
        'Cancel'
      );
      if (update !== 'Update') {
        return;
      }
    }
    config.mcpServers![SERVER_NAME] = {
      url: `http://localhost:${port}/sse`
    };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2), 'utf-8');
    const openFile = await vscode.window.showInformationMessage(
      `Cursor MCP configuration updated! Server "${SERVER_NAME}" added pointing to port ${port}.`,
      'Open mcp.json',
      'OK'
    );
    if (openFile === 'Open mcp.json') {
      const doc = await vscode.workspace.openTextDocument(mcpConfigPath);
      await vscode.window.showTextDocument(doc);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to configure Cursor: ${error}`);
  }
}
