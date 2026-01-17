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
  servers?: Record<string, MCPServerConfig>;
  mcpServers?: Record<string, MCPServerConfig>;
}

type IDE = 'cursor' | 'vscode';

const PROJECT_CONFIG_PATHS = ['.vscode/mcp.json', '.cursor/mcp.json', '.mcp.json'];

function detectIDE(): IDE {
  const appName = vscode.env.appName.toLowerCase();
  return appName.includes('cursor') ? 'cursor' : 'vscode';
}

function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

function getServersKey(_configPath: string): 'servers' | 'mcpServers' {
  // 'mcpServers' is the standard MCP schema key used by Cursor, Claude, etc.
  return 'mcpServers';
}

function readConfig(configPath: string): MCPConfig | null {
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function writeConfig(configPath: string, port: number): boolean {
  const expectedUrl = `http://localhost:${port}/sse`;
  const configDir = path.dirname(configPath);
  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    let config = readConfig(configPath);
    const serversKey = config
      ? (config.servers ? 'servers' : config.mcpServers ? 'mcpServers' : getServersKey(configPath))
      : getServersKey(configPath);
    if (!config) {
      config = {};
    }
    if (!config[serversKey]) {
      config[serversKey] = {};
    }
    const servers = config[serversKey]!;
    if (servers[SERVER_NAME]?.url === expectedUrl) {
      return true;
    }
    servers[SERVER_NAME] = { url: expectedUrl };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export interface AutoConfigResult {
  configured: boolean;
  paths: string[];
  created: boolean;
}

export function autoConfigureOnStart(port: number): AutoConfigResult {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    return { configured: false, paths: [], created: false };
  }
  const ide = detectIDE();
  const ideDir = ide === 'cursor' ? '.cursor' : '.vscode';
  const ideConfigPath = path.join(workspaceRoot, ideDir, 'mcp.json');
  const rootConfigPath = path.join(workspaceRoot, '.mcp.json');
  // Check for existing configs: IDE-specific path and .mcp.json
  const existingConfigs = [ideConfigPath, rootConfigPath].filter(p => fs.existsSync(p));
  if (existingConfigs.length > 0) {
    const updated: string[] = [];
    for (const configPath of existingConfigs) {
      if (writeConfig(configPath, port)) {
        updated.push(configPath);
      }
    }
    return { configured: updated.length > 0, paths: updated, created: false };
  }
  // No existing config, create in IDE-specific directory
  const success = writeConfig(ideConfigPath, port);
  return { configured: success, paths: success ? [ideConfigPath] : [], created: success };
}

interface GlobalConfigOption {
  label: string;
  description: string;
  path: string;
}

function getGlobalConfigOptions(): GlobalConfigOption[] {
  const options: GlobalConfigOption[] = [
    {
      label: '$(home) ~/.cursor/mcp.json',
      description: 'Cursor global config',
      path: path.join(os.homedir(), '.cursor', 'mcp.json')
    },
    {
      label: '$(home) ~/.claude.json',
      description: 'Claude Code global config',
      path: path.join(os.homedir(), '.claude.json')
    }
  ];
  const platform = os.platform();
  if (platform === 'darwin') {
    options.push({
      label: '$(desktop-download) Claude Desktop (macOS)',
      description: '~/Library/Application Support/Claude/claude_desktop_config.json',
      path: path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    });
  } else if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    options.push({
      label: '$(desktop-download) Claude Desktop (Windows)',
      description: '%APPDATA%\\Claude\\claude_desktop_config.json',
      path: path.join(appData, 'Claude', 'claude_desktop_config.json')
    });
  } else {
    options.push({
      label: '$(desktop-download) Claude Desktop (Linux)',
      description: '~/.config/Claude/claude_desktop_config.json',
      path: path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json')
    });
  }
  return options;
}

export async function configureGlobal(port: number): Promise<void> {
  const options = getGlobalConfigOptions();
  const items: (vscode.QuickPickItem & { configPath?: string })[] = options.map(opt => ({
    label: opt.label,
    description: opt.description,
    detail: fs.existsSync(opt.path) ? '$(check) File exists' : '$(new-file) Will be created',
    configPath: opt.path
  }));
  items.push({
    label: '$(edit) Enter custom path...',
    description: 'Specify a custom configuration file path'
  });
  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select MCP configuration file location',
    title: 'Configure MCP Client'
  });
  if (!selection) {
    return;
  }
  let configPath: string;
  if (selection.configPath) {
    configPath = selection.configPath;
  } else {
    const customPath = await vscode.window.showInputBox({
      prompt: 'Enter the path to the MCP configuration file',
      placeHolder: '/path/to/mcp.json',
      validateInput: (value) => {
        if (!value.trim()) {
          return 'Path cannot be empty';
        }
        if (!value.endsWith('.json')) {
          return 'File must have .json extension';
        }
        return undefined;
      }
    });
    if (!customPath) {
      return;
    }
    configPath = customPath.startsWith('~')
      ? path.join(os.homedir(), customPath.slice(1))
      : customPath;
  }
  try {
    let config = readConfig(configPath);
    const isClaudeDesktop = configPath.includes('claude_desktop_config');
    const serversKey = isClaudeDesktop ? 'mcpServers' : (config?.servers ? 'servers' : 'mcpServers');
    if (!config) {
      config = {};
    }
    if (!config[serversKey]) {
      config[serversKey] = {};
    }
    const servers = config[serversKey]!;
    const existingServer = servers[SERVER_NAME];
    if (existingServer) {
      const update = await vscode.window.showWarningMessage(
        `Server "${SERVER_NAME}" already exists. Update it?`,
        'Update',
        'Cancel'
      );
      if (update !== 'Update') {
        return;
      }
    }
    servers[SERVER_NAME] = { url: `http://localhost:${port}/sse` };
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    const action = await vscode.window.showInformationMessage(
      `MCP configuration updated: ${path.basename(configPath)}`,
      'Open File',
      'OK'
    );
    if (action === 'Open File') {
      const doc = await vscode.workspace.openTextDocument(configPath);
      await vscode.window.showTextDocument(doc);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to configure: ${error}`);
  }
}

export interface GlobalConfigConflict {
  path: string;
  configuredPort: number;
}

export function removeFromGlobalConfigs(configPaths: string[]): { removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const configPath of configPaths) {
    try {
      const config = readConfig(configPath);
      if (!config) continue;
      const serversKey = config.mcpServers ? 'mcpServers' : config.servers ? 'servers' : null;
      if (!serversKey || !config[serversKey]?.[SERVER_NAME]) continue;
      delete config[serversKey]![SERVER_NAME];
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      removed.push(configPath);
    } catch {
      failed.push(configPath);
    }
  }
  return { removed, failed };
}

export function checkGlobalConfigConflicts(runningPort: number): GlobalConfigConflict[] {
  const conflicts: GlobalConfigConflict[] = [];
  const globalPaths = getGlobalConfigOptions();
  for (const opt of globalPaths) {
    const config = readConfig(opt.path);
    if (!config) continue;
    const servers = config.mcpServers || config.servers;
    const serverConfig = servers?.[SERVER_NAME];
    if (!serverConfig?.url) continue;
    const match = serverConfig.url.match(/:(\d+)\//);
    if (match) {
      const configuredPort = parseInt(match[1], 10);
      if (configuredPort !== runningPort) {
        conflicts.push({ path: opt.path, configuredPort });
      }
    }
  }
  return conflicts;
}
