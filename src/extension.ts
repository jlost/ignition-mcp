import * as vscode from 'vscode';
import { MCPServer } from './server/mcpServer';
import { TaskManager } from './tasks/taskManager';
import { configureForCursor, autoConfigureOnStart, removeConfigOnStop } from './config/autoConfig';

let mcpServer: MCPServer | null = null;
let taskManager: TaskManager | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;

export function activate(context: vscode.ExtensionContext) {
  console.log('Tasks MCP extension is activating...');
  taskManager = new TaskManager();
  context.subscriptions.push(taskManager);
  const config = vscode.workspace.getConfiguration('tasks-mcp');
  const port = config.get<number>('port', 3500);
  const autoStart = config.get<boolean>('autoStart', true);
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'tasks-mcp.show-status';
  context.subscriptions.push(statusBarItem);
  updateStatusBar(false);
  context.subscriptions.push(
    vscode.commands.registerCommand('tasks-mcp.enable', () => enableServer(port)),
    vscode.commands.registerCommand('tasks-mcp.disable', () => disableServer()),
    vscode.commands.registerCommand('tasks-mcp.configure-cursor', () => configureForCursor(port)),
    vscode.commands.registerCommand('tasks-mcp.show-status', () => showStatusQuickPick(port))
  );
  if (autoStart) {
    enableServer(port);
  }
  console.log('Tasks MCP extension activated');
}

export function deactivate() {
  if (mcpServer) {
    mcpServer.stop();
    mcpServer = null;
  }
}

async function enableServer(port: number) {
  if (mcpServer) {
    vscode.window.showInformationMessage(`MCP server is already running on port ${port}`);
    return;
  }
  if (!taskManager) {
    vscode.window.showErrorMessage('Task manager not initialized');
    return;
  }
  try {
    mcpServer = new MCPServer(taskManager, port);
    await mcpServer.start();
    updateStatusBar(true);
    const configResult = autoConfigureOnStart(port);
    if (configResult.added) {
      vscode.window.showInformationMessage(
        `MCP server started on port ${port}. Added to ~/.cursor/mcp.json (restart Cursor to connect).`
      );
    } else {
      vscode.window.showInformationMessage(`MCP server started on port ${port}`);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to start MCP server: ${error}`);
    mcpServer = null;
  }
}

async function disableServer() {
  if (!mcpServer) {
    vscode.window.showInformationMessage('MCP server is not running');
    return;
  }
  await mcpServer.stop();
  mcpServer = null;
  updateStatusBar(false);
  const config = vscode.workspace.getConfiguration('tasks-mcp');
  const removeOnStop = config.get<boolean>('removeConfigOnStop', false);
  if (removeOnStop) {
    removeConfigOnStop();
  }
  vscode.window.showInformationMessage('MCP server stopped');
}

function updateStatusBar(running: boolean) {
  if (!statusBarItem) return;
  const config = vscode.workspace.getConfiguration('tasks-mcp');
  const port = config.get<number>('port', 3500);
  if (running) {
    statusBarItem.text = `$(server) MCP: Running (${port})`;
    statusBarItem.tooltip = 'Tasks MCP Server is running. Click for options.';
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = '$(server) MCP: Stopped';
    statusBarItem.tooltip = 'Tasks MCP Server is stopped. Click to start.';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusBarItem.show();
}

async function showStatusQuickPick(port: number) {
  const isRunning = mcpServer !== null;
  const items: vscode.QuickPickItem[] = [];
  if (isRunning) {
    items.push(
      { label: '$(stop) Stop Server', description: 'Disable the MCP server' },
      { label: '$(refresh) Restart Server', description: 'Restart the MCP server' }
    );
  } else {
    items.push({ label: '$(play) Start Server', description: 'Enable the MCP server' });
  }
  items.push(
    { label: '$(gear) Configure Cursor', description: 'Add to ~/.cursor/mcp.json' },
    { label: '$(info) Server Info', description: `Port: ${port}, Status: ${isRunning ? 'Running' : 'Stopped'}` }
  );
  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: 'Tasks MCP Server Options'
  });
  if (!selection) return;
  if (selection.label.includes('Stop')) {
    await disableServer();
  } else if (selection.label.includes('Start')) {
    await enableServer(port);
  } else if (selection.label.includes('Restart')) {
    await disableServer();
    await enableServer(port);
  } else if (selection.label.includes('Configure')) {
    await configureForCursor(port);
  }
}
