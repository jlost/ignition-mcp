import * as vscode from 'vscode';

export interface LaunchInputDefinition {
  id: string;
  type: 'promptString' | 'pickString' | 'command';
  description?: string;
  default?: string;
  options?: string[];
}

export interface McpOptions {
  returnOutput?: 'always' | 'onFailure' | 'never';
  preserveConsole?: boolean;
}

export interface LaunchInfo {
  name: string;
  type: string;
  request: 'launch' | 'attach';
  preLaunchTask?: string;
  postDebugTask?: string;
  inputs?: LaunchInputDefinition[];
  rawConfig?: Record<string, unknown>;
  mcpOptions?: McpOptions;
}

export interface ExceptionInfo {
  exceptionId: string;
  description?: string;
  breakMode?: string;
}

export interface DebugSessionInfo {
  id: string;
  name: string;
  type: string;
  status: 'active' | 'terminated';
  state: 'initializing' | 'running' | 'paused' | 'terminated';
  startTime: number;
  endTime?: number;
  stopReason?: string;
  exceptionInfo?: ExceptionInfo;
  stoppedThreadId?: number;
  consoleOverridden?: boolean;
}

export interface StartDebugResult {
  success: boolean;
  sessionId?: string;
  consoleOverridden?: boolean;
  error?: string;
}

export interface StopDebugResult {
  success: boolean;
  error?: string;
}

export interface DebugStatusResult {
  activeSessions: DebugSessionInfo[];
}

export interface StackFrame {
  id: number;
  name: string;
  source?: { name?: string; path?: string };
  line: number;
  column: number;
}

export interface StackTraceResult {
  success: boolean;
  sessionId?: string;
  threadId?: number;
  stackFrames?: StackFrame[];
  error?: string;
}

export interface DebugOutputResult {
  success: boolean;
  sessionId?: string;
  output?: string;
  error?: string;
}

export class LaunchManager implements vscode.Disposable {
  private sessions: Map<string, DebugSessionInfo> = new Map();
  private outputs: Map<string, string[]> = new Map();
  private pendingConsoleOverrides: Map<string, boolean> = new Map();
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.debug.onDidStartDebugSession((session) => this.onSessionStarted(session)),
      vscode.debug.onDidTerminateDebugSession((session) => this.onSessionTerminated(session))
    );
    this.registerDebugAdapterTracker();
  }

  private registerDebugAdapterTracker() {
    const self = this;
    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterTracker> {
          return {
            onDidSendMessage(message: { type: string; event?: string; body?: Record<string, unknown> }) {
              if (message.type === 'event') {
                self.handleDebugEvent(session.id, message.event, message.body);
              }
            }
          };
        }
      })
    );
  }

  private handleDebugEvent(sessionId: string, event: string | undefined, body: Record<string, unknown> | undefined) {
    const info = this.sessions.get(sessionId);
    if (!body) return;
    switch (event) {
      case 'initialized':
        if (info) {
          info.state = 'running';
        }
        break;
      case 'output':
        this.captureOutput(sessionId, body);
        break;
      case 'stopped':
        if (info) {
          info.state = 'paused';
          info.stopReason = body.reason as string | undefined;
          info.stoppedThreadId = body.threadId as number | undefined;
          if (body.reason === 'exception') {
            info.exceptionInfo = {
              exceptionId: (body.text as string) || 'unknown',
              description: body.description as string | undefined
            };
          }
        }
        break;
      case 'continued':
        if (info) {
          info.state = 'running';
          info.stopReason = undefined;
          info.stoppedThreadId = undefined;
        }
        break;
      case 'exited':
      case 'terminated':
        if (info) {
          info.state = 'terminated';
        }
        break;
    }
  }

  private captureOutput(sessionId: string, body: Record<string, unknown>) {
    const output = body.output as string | undefined;
    if (!output) return;
    let outputs = this.outputs.get(sessionId);
    if (!outputs) {
      outputs = [];
      this.outputs.set(sessionId, outputs);
    }
    outputs.push(output);
  }

  async listLaunchConfigs(): Promise<LaunchInfo[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return [];
    }
    const configs: LaunchInfo[] = [];
    for (const folder of workspaceFolders) {
      const launchConfig = vscode.workspace.getConfiguration('launch', folder.uri);
      const configurations = launchConfig.get<Record<string, unknown>[]>('configurations') || [];
      const inputDefinitions = launchConfig.get<LaunchInputDefinition[]>('inputs') || [];
      for (const config of configurations) {
        if (!config.name || !config.type || !config.request) {
          continue;
        }
        const configStr = JSON.stringify(config);
        const usedInputIds = this.findInputReferences(configStr);
        const inputs = usedInputIds.length > 0
          ? inputDefinitions.filter((inp: LaunchInputDefinition) => usedInputIds.includes(inp.id))
          : undefined;
        configs.push({
          name: config.name as string,
          type: config.type as string,
          request: config.request as 'launch' | 'attach',
          preLaunchTask: config.preLaunchTask as string | undefined,
          postDebugTask: config.postDebugTask as string | undefined,
          inputs,
          rawConfig: config,
          mcpOptions: config.mcp as McpOptions | undefined
        });
      }
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
        debugConfig = { ...config.rawConfig } as vscode.DebugConfiguration;
      }
      let consoleOverridden = false;
      const originalConsole = debugConfig.console;
      if (originalConsole === 'integratedTerminal' || originalConsole === 'externalTerminal') {
        if (!config.mcpOptions?.preserveConsole) {
          debugConfig.console = 'internalConsole';
          consoleOverridden = true;
          console.warn(`[MCP] Overriding console "${originalConsole}" -> "internalConsole" for output capture. Set mcp.preserveConsole: true to disable.`);
        }
      }
      const pendingId = `pending-${Date.now()}`;
      this.pendingConsoleOverrides.set(pendingId, consoleOverridden);
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const started = await vscode.debug.startDebugging(workspaceFolder, debugConfig);
      if (!started) {
        this.pendingConsoleOverrides.delete(pendingId);
        return { success: false, error: 'Failed to start debug session' };
      }
      const activeSession = vscode.debug.activeDebugSession;
      const sessionId = activeSession?.id || `debug-${Date.now()}`;
      if (activeSession && consoleOverridden) {
        const info = this.sessions.get(activeSession.id);
        if (info) {
          info.consoleOverridden = true;
        }
      }
      this.pendingConsoleOverrides.delete(pendingId);
      return { success: true, sessionId, consoleOverridden };
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
    if (vscode.debug.activeDebugSession?.id === sessionId) {
      return vscode.debug.activeDebugSession;
    }
    return undefined;
  }

  private onSessionStarted(session: vscode.DebugSession) {
    const info: DebugSessionInfo = {
      id: session.id,
      name: session.name,
      type: session.type,
      status: 'active',
      state: 'initializing',
      startTime: Date.now()
    };
    this.sessions.set(session.id, info);
    this.outputs.set(session.id, []);
    console.log(`Debug session started: ${session.name} (${session.id})`);
  }

  private onSessionTerminated(session: vscode.DebugSession) {
    const info = this.sessions.get(session.id);
    if (info) {
      info.status = 'terminated';
      info.state = 'terminated';
      info.endTime = Date.now();
    }
    console.log(`Debug session terminated: ${session.name} (${session.id})`);
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

  getDebugOutput(sessionId?: string): DebugOutputResult {
    const targetId = sessionId || vscode.debug.activeDebugSession?.id;
    if (!targetId) {
      return { success: false, error: 'No active debug session' };
    }
    const outputs = this.outputs.get(targetId);
    if (!outputs) {
      return { success: false, sessionId: targetId, error: 'Session not found or no output captured' };
    }
    return { success: true, sessionId: targetId, output: outputs.join('') };
  }

  async getStackTrace(sessionId?: string): Promise<StackTraceResult> {
    const targetId = sessionId || vscode.debug.activeDebugSession?.id;
    if (!targetId) {
      return { success: false, error: 'No active debug session' };
    }
    const info = this.sessions.get(targetId);
    if (!info) {
      return { success: false, sessionId: targetId, error: 'Session not found' };
    }
    if (info.state !== 'paused') {
      return { success: false, sessionId: targetId, error: `Session is not paused (state: ${info.state})` };
    }
    const threadId = info.stoppedThreadId;
    if (!threadId) {
      return { success: false, sessionId: targetId, error: 'No stopped thread ID available' };
    }
    const session = this.findSessionById(targetId);
    if (!session) {
      return { success: false, sessionId: targetId, error: 'Debug session not found' };
    }
    try {
      const response = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 20 });
      const stackFrames: StackFrame[] = (response.stackFrames || []).map((frame: Record<string, unknown>) => ({
        id: frame.id as number,
        name: frame.name as string,
        source: frame.source as { name?: string; path?: string } | undefined,
        line: frame.line as number,
        column: frame.column as number
      }));
      return { success: true, sessionId: targetId, threadId, stackFrames };
    } catch (error) {
      return { success: false, sessionId: targetId, error: `Failed to get stack trace: ${String(error)}` };
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.sessions.clear();
    this.outputs.clear();
    this.pendingConsoleOverrides.clear();
  }
}
