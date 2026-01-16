import * as vscode from 'vscode';
import { MCPServer } from './server/mcpServer';
import { TaskManager } from './tasks/taskManager';
import { LaunchManager } from './launch/launchManager';
import { configureGlobal, autoConfigureOnStart } from './config/autoConfig';

let mcpServer: MCPServer | null = null;
let taskManager: TaskManager | null = null;
let launchManager: LaunchManager | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let outputChannel: vscode.OutputChannel | null = null;

function log(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  outputChannel?.appendLine(`[${timestamp}] ${message}`);
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Ignition MCP');
  context.subscriptions.push(outputChannel);
  log('Ignition MCP extension activating...');
  taskManager = new TaskManager();
  launchManager = new LaunchManager();
  context.subscriptions.push(taskManager);
  context.subscriptions.push(launchManager);
  const config = vscode.workspace.getConfiguration('ignition-mcp');
  const port = config.get<number>('port', 3500);
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'ignition-mcp.show-status';
  context.subscriptions.push(statusBarItem);
  updateStatusBar(false);
  context.subscriptions.push(
    vscode.commands.registerCommand('ignition-mcp.configure', () => configureGlobal(port)),
    vscode.commands.registerCommand('ignition-mcp.show-status', () => showStatusQuickPick(port))
  );
  enableServer(port);
  log('Ignition MCP extension activated');
}

export function deactivate() {
  if (mcpServer) {
    mcpServer.stop();
    mcpServer = null;
  }
}

async function enableServer(port: number) {
  if (mcpServer) {
    log(`Server already running on port ${port}`);
    return;
  }
  if (!taskManager || !launchManager) {
    log('Error: Task manager or launch manager not initialized');
    vscode.window.showErrorMessage('Task manager or launch manager not initialized');
    return;
  }
  try {
    log(`Starting MCP server on port ${port}...`);
    mcpServer = new MCPServer(taskManager, launchManager, port);
    await mcpServer.start();
    updateStatusBar(true);
    log(`MCP server started successfully on port ${port}`);
    const configResult = autoConfigureOnStart(port);
    if (configResult.configured) {
      const pathNames = configResult.paths.map(p => p.split('/').slice(-2).join('/'));
      log(`Updated MCP config: ${pathNames.join(', ')}`);
      if (configResult.created) {
        vscode.window.showInformationMessage(
          `MCP server started on port ${port}. Created ${pathNames.join(', ')}.`
        );
      }
    }
  } catch (error) {
    log(`Failed to start MCP server: ${error}`);
    vscode.window.showErrorMessage(`Failed to start MCP server: ${error}`);
    mcpServer = null;
  }
}

function updateStatusBar(running: boolean) {
  if (!statusBarItem) return;
  const config = vscode.workspace.getConfiguration('ignition-mcp');
  const port = config.get<number>('port', 3500);
  if (running) {
    statusBarItem.text = '$(flame)';
    statusBarItem.tooltip = `Ignition MCP running on port ${port}`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = '$(flame)';
    statusBarItem.tooltip = 'Ignition MCP is not running';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusBarItem.show();
}

async function showStatusQuickPick(port: number) {
  const isRunning = mcpServer !== null;
  const items: vscode.QuickPickItem[] = [
    { label: '$(gear) Configure MCP Client', description: 'Add to global config (Cursor, Claude, etc.)' },
    { label: '$(output) Show Output', description: `Port: ${port}, Status: ${isRunning ? 'Running' : 'Stopped'}` }
  ];
  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: 'Ignition MCP'
  });
  if (!selection) return;
  if (selection.label.includes('Configure')) {
    await configureGlobal(port);
  } else if (selection.label.includes('Output')) {
    outputChannel?.show();
  }
}
