import * as vscode from 'vscode';
import { MCPServer } from './server/mcpServer';
import { TaskManager } from './tasks/taskManager';
import { LaunchManager } from './launch/launchManager';
import { configureGlobal, autoConfigureOnStart, checkGlobalConfigConflicts, removeFromGlobalConfigs } from './config/autoConfig';
import * as path from 'path';
import { getWorkspacePort, checkServerOwnership, requestShutdown, sleep } from './utils/portUtils';

type ServerState = 'running' | 'deferred' | 'stopped';

let mcpServer: MCPServer | null = null;
let taskManager: TaskManager | null = null;
let launchManager: LaunchManager | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let outputChannel: vscode.OutputChannel | null = null;
let serverState: ServerState = 'stopped';
let currentPort: number = 3500;

function log(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  outputChannel?.appendLine(`[${timestamp}] ${message}`);
}

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Ignition MCP');
  context.subscriptions.push(outputChannel);
  log('Ignition MCP extension activating...');
  taskManager = new TaskManager();
  taskManager.setOutputChannel(outputChannel);
  launchManager = new LaunchManager();
  context.subscriptions.push(taskManager);
  context.subscriptions.push(launchManager);
  // Compute port based on workspace path
  const workspacePath = getWorkspacePath();
  currentPort = workspacePath ? getWorkspacePort(workspacePath) : 3500;
  log(`Computed port ${currentPort} for workspace: ${workspacePath || 'none'}`);
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'ignition-mcp.show-status';
  context.subscriptions.push(statusBarItem);
  updateStatusBar();
  context.subscriptions.push(
    vscode.commands.registerCommand('ignition-mcp.configure', () => configureGlobal(currentPort)),
    vscode.commands.registerCommand('ignition-mcp.show-status', showStatusQuickPick),
    vscode.commands.registerCommand('ignition-mcp.takeover', handleTakeover),
    vscode.commands.registerCommand('ignition-mcp.restart', handleRestart)
  );
  await initializeServer();
  log('Ignition MCP extension activated');
}

function getWorkspacePath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

async function initializeServer() {
  const ownership = await checkServerOwnership(currentPort);
  log(`Port ${currentPort} ownership check: ${ownership}`);
  switch (ownership) {
    case 'free':
      await enableServer();
      break;
    case 'ours':
      // Another ignition-mcp instance owns this port
      serverState = 'deferred';
      updateStatusBar();
      log('Server deferred - another Ignition MCP window owns this port');
      break;
    case 'other':
      // Port is used by a different application
      serverState = 'stopped';
      updateStatusBar();
      log(`Port ${currentPort} is in use by another application`);
      vscode.window.showErrorMessage(
        `Port ${currentPort} is in use by another application. Cannot start MCP server.`
      );
      break;
  }
}

async function handleTakeover() {
  log('Takeover requested...');
  const shutdownSent = await requestShutdown(currentPort);
  if (shutdownSent) {
    log('Shutdown request sent, waiting for port release...');
    await sleep(300);
  }
  await enableServer();
}

async function handleRestart() {
  log('Restart requested...');
  if (mcpServer) {
    log('Stopping current server...');
    await mcpServer.stop();
    mcpServer = null;
    serverState = 'stopped';
    updateStatusBar();
  }
  await sleep(100);
  await enableServer();
  if (serverState === 'running') {
    vscode.window.showInformationMessage(
      `Ignition MCP server restarted on port ${currentPort}. You may need to toggle the MCP in Cursor settings to reconnect.`
    );
  }
}

export function deactivate() {
  if (mcpServer) {
    mcpServer.stop();
    mcpServer = null;
  }
}

async function enableServer() {
  if (mcpServer) {
    log(`Server already running on port ${currentPort}`);
    return;
  }
  if (!taskManager || !launchManager) {
    log('Error: Task manager or launch manager not initialized');
    vscode.window.showErrorMessage('Task manager or launch manager not initialized');
    return;
  }
  try {
    log(`Starting MCP server on port ${currentPort}...`);
    mcpServer = new MCPServer(taskManager, launchManager, currentPort, handleShutdownRequested);
    if (outputChannel) {
      mcpServer.setOutputChannel(outputChannel);
    }
    await mcpServer.start();
    serverState = 'running';
    updateStatusBar();
    log(`MCP server started successfully on port ${currentPort}`);
    const configResult = autoConfigureOnStart(currentPort);
    if (configResult.configured) {
      const pathNames = configResult.paths.map(p => p.split('/').slice(-2).join('/'));
      log(`Updated MCP config: ${pathNames.join(', ')}`);
      if (configResult.created) {
        vscode.window.showInformationMessage(
          `MCP server started on port ${currentPort}. Created ${pathNames.join(', ')}.`
        );
      }
    }
    const conflicts = checkGlobalConfigConflicts(currentPort);
    if (conflicts.length > 0) {
      const names = conflicts.map(c => path.basename(c.path)).join(', ');
      log(`WARNING: Global config(s) have ignition-mcp at different port: ${names}`);
      const action = await vscode.window.showWarningMessage(
        `Global MCP config has ignition-mcp at port ${conflicts[0].configuredPort}, but server is running on ${currentPort}. This may cause connection failures.`,
        'Update Global',
        'Remove from Global',
        'Ignore'
      );
      if (action === 'Update Global') {
        await configureGlobal(currentPort);
      } else if (action === 'Remove from Global') {
        const result = removeFromGlobalConfigs(conflicts.map(c => c.path));
        if (result.removed.length > 0) {
          const removedNames = result.removed.map(p => path.basename(p)).join(', ');
          log(`Removed ignition-mcp from: ${removedNames}`);
          vscode.window.showInformationMessage(`Removed ignition-mcp from ${removedNames}`);
        }
        if (result.failed.length > 0) {
          const failedNames = result.failed.map(p => path.basename(p)).join(', ');
          log(`Failed to remove from: ${failedNames}`);
          vscode.window.showErrorMessage(`Failed to remove from: ${failedNames}`);
        }
      }
    }
  } catch (error) {
    log(`Failed to start MCP server: ${error}`);
    serverState = 'stopped';
    updateStatusBar();
    vscode.window.showErrorMessage(`Failed to start MCP server: ${error}`);
    mcpServer = null;
  }
}

function handleShutdownRequested() {
  log('Shutdown requested by another window (takeover)');
  if (mcpServer) {
    mcpServer.stop();
    mcpServer = null;
  }
  serverState = 'deferred';
  updateStatusBar();
}

function updateStatusBar() {
  if (!statusBarItem) return;
  statusBarItem.text = '$(flame)';
  switch (serverState) {
    case 'running':
      statusBarItem.tooltip = `Ignition MCP running on port ${currentPort}`;
      statusBarItem.backgroundColor = undefined;
      break;
    case 'deferred':
      statusBarItem.tooltip = `Ignition MCP (served by another window) - port ${currentPort}`;
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      break;
    case 'stopped':
      statusBarItem.tooltip = 'Ignition MCP is not running';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      break;
  }
  statusBarItem.show();
}

async function showStatusQuickPick() {
  const items: vscode.QuickPickItem[] = [
    { label: '$(gear) Configure MCP Client', description: 'Add to global config (Cursor, Claude, etc.)' }
  ];
  // Add state-specific options
  if (serverState === 'deferred') {
    items.push({
      label: '$(arrow-swap) Take Over Server',
      description: 'Stop the other window\'s server and start here'
    });
  }
  if (serverState === 'running') {
    items.push({
      label: '$(sync) Restart Server',
      description: 'Restart the MCP server (helps if Cursor shows red status)'
    });
  }
  // Status description based on state
  let statusDesc: string;
  switch (serverState) {
    case 'running':
      statusDesc = `Port: ${currentPort}, Status: Running`;
      break;
    case 'deferred':
      statusDesc = `Port: ${currentPort}, Status: Served by another window`;
      break;
    case 'stopped':
      statusDesc = `Port: ${currentPort}, Status: Stopped`;
      break;
  }
  items.push({ label: '$(output) Show Output', description: statusDesc });
  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: 'Ignition MCP'
  });
  if (!selection) return;
  if (selection.label.includes('Configure')) {
    await configureGlobal(currentPort);
  } else if (selection.label.includes('Take Over')) {
    await handleTakeover();
  } else if (selection.label.includes('Restart')) {
    await handleRestart();
  } else if (selection.label.includes('Output')) {
    outputChannel?.show();
  }
}
