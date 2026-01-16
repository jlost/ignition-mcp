import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface LaunchInputDefinition {
  id: string;
  type: 'promptString' | 'pickString' | 'command';
  description?: string;
  default?: string;
  options?: string[];
}

export interface LaunchInfo {
  name: string;
  type: string;
  request: 'launch' | 'attach';
  preLaunchTask?: string;
  postDebugTask?: string;
  inputs?: LaunchInputDefinition[];
  rawConfig?: Record<string, unknown>;
}

export interface DebugSessionInfo {
  id: string;
  name: string;
  type: string;
  status: 'active' | 'terminated';
  startTime: number;
  endTime?: number;
}

export interface StartDebugResult {
  success: boolean;
  sessionId?: string;
  error?: string;
}

export interface StopDebugResult {
  success: boolean;
  error?: string;
}

export interface DebugStatusResult {
  activeSessions: DebugSessionInfo[];
}

export class LaunchManager implements vscode.Disposable {
  private sessions: Map<string, DebugSessionInfo> = new Map();
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.debug.onDidStartDebugSession((session) => this.onSessionStarted(session)),
      vscode.debug.onDidTerminateDebugSession((session) => this.onSessionTerminated(session))
    );
  }

  async listLaunchConfigs(): Promise<LaunchInfo[]> {
    const launchJsonData = this.readLaunchJson();
    if (!launchJsonData || !launchJsonData.configurations) {
      return [];
    }
    const inputDefinitions = launchJsonData.inputs || [];
    const configs: LaunchInfo[] = [];
    for (const config of launchJsonData.configurations) {
      if (!config.name || !config.type || !config.request) {
        continue;
      }
      const configStr = JSON.stringify(config);
      const usedInputIds = this.findInputReferences(configStr);
      const inputs = usedInputIds.length > 0
        ? inputDefinitions.filter((inp: LaunchInputDefinition) => usedInputIds.includes(inp.id))
        : undefined;
      configs.push({
        name: config.name,
        type: config.type,
        request: config.request,
        preLaunchTask: config.preLaunchTask,
        postDebugTask: config.postDebugTask,
        inputs,
        rawConfig: config
      });
    }
    return configs;
  }

  async startDebug(
    configName: string,
    inputValues?: Record<string, string>
  ): Promise<StartDebugResult> {
    const configs = await this.listLaunchConfigs();
    const config = configs.find((c) => c.name === configName);
    if (!config) {
      return { success: false, error: `Launch configuration "${configName}" not found` };
    }
    try {
      let debugConfig: vscode.DebugConfiguration;
      if (inputValues && Object.keys(inputValues).length > 0 && config.rawConfig) {
        debugConfig = this.substituteInputs(config.rawConfig, inputValues) as vscode.DebugConfiguration;
      } else {
        debugConfig = config.rawConfig as vscode.DebugConfiguration;
      }
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const started = await vscode.debug.startDebugging(workspaceFolder, debugConfig);
      if (!started) {
        return { success: false, error: 'Failed to start debug session' };
      }
      const activeSession = vscode.debug.activeDebugSession;
      const sessionId = activeSession?.id || `debug-${Date.now()}`;
      return { success: true, sessionId };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async stopDebug(sessionId?: string): Promise<StopDebugResult> {
    try {
      if (sessionId) {
        const session = this.findSessionById(sessionId);
        if (session) {
          await vscode.debug.stopDebugging(session);
        } else {
          return { success: false, error: `Session "${sessionId}" not found` };
        }
      } else {
        await vscode.debug.stopDebugging();
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  getDebugStatus(): DebugStatusResult {
    const activeSessions: DebugSessionInfo[] = [];
    for (const session of this.sessions.values()) {
      if (session.status === 'active') {
        activeSessions.push(session);
      }
    }
    return { activeSessions };
  }

  private findSessionById(sessionId: string): vscode.DebugSession | undefined {
    for (const session of vscode.debug.activeDebugSession ? [vscode.debug.activeDebugSession] : []) {
      if (session.id === sessionId) {
        return session;
      }
    }
    return undefined;
  }

  private onSessionStarted(session: vscode.DebugSession) {
    const info: DebugSessionInfo = {
      id: session.id,
      name: session.name,
      type: session.type,
      status: 'active',
      startTime: Date.now()
    };
    this.sessions.set(session.id, info);
    console.log(`Debug session started: ${session.name} (${session.id})`);
  }

  private onSessionTerminated(session: vscode.DebugSession) {
    const info = this.sessions.get(session.id);
    if (info) {
      info.status = 'terminated';
      info.endTime = Date.now();
    }
    console.log(`Debug session terminated: ${session.name} (${session.id})`);
  }

  private readLaunchJson(): {
    configurations?: Record<string, unknown>[];
    inputs?: LaunchInputDefinition[];
  } | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }
    const launchJsonPath = path.join(workspaceFolders[0].uri.fsPath, '.vscode', 'launch.json');
    if (!fs.existsSync(launchJsonPath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(launchJsonPath, 'utf-8');
      const cleanedContent = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      return JSON.parse(cleanedContent);
    } catch {
      return null;
    }
  }

  private findInputReferences(text: string): string[] {
    const regex = /\$\{input:([^}]+)\}/g;
    const matches: string[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (!matches.includes(match[1])) {
        matches.push(match[1]);
      }
    }
    return matches;
  }

  private substituteInputs(
    config: Record<string, unknown>,
    inputValues: Record<string, string>
  ): Record<string, unknown> {
    const configStr = JSON.stringify(config);
    let substituted = configStr;
    for (const [inputId, value] of Object.entries(inputValues)) {
      const pattern = new RegExp(`\\$\\{input:${inputId}\\}`, 'g');
      substituted = substituted.replace(pattern, value);
    }
    return JSON.parse(substituted);
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.sessions.clear();
  }
}
