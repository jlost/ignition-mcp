import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface MCPServerConfig {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface MCPConfig {
  mcpServers?: Record<string, MCPServerConfig>;
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
    const serverName = 'vscode-tasks';
    const existingServer = config.mcpServers[serverName];
    if (existingServer) {
      const update = await vscode.window.showWarningMessage(
        `Server "${serverName}" already exists in mcp.json. Update it?`,
        'Update',
        'Cancel'
      );
      if (update !== 'Update') {
        return;
      }
    }
    config.mcpServers[serverName] = {
      url: `http://localhost:${port}/sse`
    };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2), 'utf-8');
    const openFile = await vscode.window.showInformationMessage(
      `Cursor MCP configuration updated! Server "vscode-tasks" added pointing to port ${port}.`,
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
