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
  outputLimit?: number | null;
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
  truncated?: boolean;
  error?: string;
}

export interface BreakpointInfo {
  id: string;
  file: string;
  line: number;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface AddBreakpointResult {
  success: boolean;
  id?: string;
  error?: string;
}

export interface RemoveBreakpointResult {
  success: boolean;
  removed?: number;
  error?: string;
}

export interface VariableInfo {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export interface ScopeInfo {
  name: string;
  variablesReference: number;
  variables: VariableInfo[];
}

export interface GetVariablesResult {
  success: boolean;
  sessionId?: string;
  frameId?: number;
  scopes?: ScopeInfo[];
  error?: string;
}

export interface EvaluateResult {
  success: boolean;
  result?: string;
  type?: string;
  variablesReference?: number;
  error?: string;
}

export interface ContinueResult {
  success: boolean;
  allThreadsContinued?: boolean;
  error?: string;
}

export class LaunchManager implements vscode.Disposable {
  private sessions: Map<string, DebugSessionInfo> = new Map();
  private outputs: Map<string, string[]> = new Map();
  private outputLengths: Map<string, number> = new Map();
  private outputTruncated: Map<string, boolean> = new Map();
  private outputLimits: Map<string, number | null> = new Map();
  private pendingOutputLimits: Map<string, number | null> = new Map();
  private pendingConsoleOverrides: Map<string, boolean> = new Map();
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.debug.onDidStartDebugSession((session) => this.onSessionStarted(session)),
      vscode.debug.onDidTerminateDebugSession((session) => this.onSessionTerminated(session))
    );
    this.registerDebugAdapterTracker();
  }

  private getDefaultOutputLimit(): number | null {
    const config = vscode.workspace.getConfiguration('ignition-mcp');
    return config.get<number | null>('outputLimit', 20480);
  }

  private getOutputLimitForSession(sessionId: string): number | null {
    const limit = this.outputLimits.get(sessionId);
    return limit !== undefined ? limit : this.getDefaultOutputLimit();
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
    const limit = this.getOutputLimitForSession(sessionId);
    const currentLength = this.outputLengths.get(sessionId) || 0;
    if (limit !== null && currentLength >= limit) {
      return;
    }
    let outputs = this.outputs.get(sessionId);
    if (!outputs) {
      outputs = [];
      this.outputs.set(sessionId, outputs);
    }
    if (limit !== null && currentLength + output.length > limit) {
      const remaining = limit - currentLength;
      outputs.push(output.slice(0, remaining));
      this.outputLengths.set(sessionId, limit);
      this.outputTruncated.set(sessionId, true);
    } else {
      outputs.push(output);
      this.outputLengths.set(sessionId, currentLength + output.length);
    }
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
      if (config.mcpOptions?.outputLimit !== undefined) {
        this.pendingOutputLimits.set(pendingId, config.mcpOptions.outputLimit);
      }
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const started = await vscode.debug.startDebugging(workspaceFolder, debugConfig);
      if (!started) {
        this.pendingConsoleOverrides.delete(pendingId);
        this.pendingOutputLimits.delete(pendingId);
        return { success: false, error: 'Failed to start debug session' };
      }
      const activeSession = vscode.debug.activeDebugSession;
      const sessionId = activeSession?.id || `debug-${Date.now()}`;
      if (activeSession) {
        if (consoleOverridden) {
          const info = this.sessions.get(activeSession.id);
          if (info) {
            info.consoleOverridden = true;
          }
        }
        if (config.mcpOptions?.outputLimit !== undefined) {
          this.outputLimits.set(activeSession.id, config.mcpOptions.outputLimit);
        }
      }
      this.pendingConsoleOverrides.delete(pendingId);
      this.pendingOutputLimits.delete(pendingId);
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
    this.outputLengths.set(session.id, 0);
    this.outputTruncated.delete(session.id);
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
    const truncated = this.outputTruncated.get(targetId);
    let output = outputs.join('');
    if (truncated) {
      const limit = this.getOutputLimitForSession(targetId);
      output += `\n\n[Output truncated: showing first ${limit} characters]`;
    }
    return { success: true, sessionId: targetId, output, truncated };
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

  async addBreakpoint(file: string, line: number, condition?: string): Promise<AddBreakpointResult> {
    try {
      const uri = vscode.Uri.file(file);
      const location = new vscode.Location(uri, new vscode.Position(line - 1, 0));
      const breakpoint = new vscode.SourceBreakpoint(location, true, condition);
      vscode.debug.addBreakpoints([breakpoint]);
      const id = `${file}:${line}`;
      return { success: true, id };
    } catch (error) {
      return { success: false, error: `Failed to add breakpoint: ${String(error)}` };
    }
  }

  async removeBreakpoint(file: string, line: number): Promise<RemoveBreakpointResult> {
    try {
      const targetLine = line - 1;
      const toRemove = vscode.debug.breakpoints.filter((bp) => {
        if (bp instanceof vscode.SourceBreakpoint) {
          const bpUri = bp.location.uri.fsPath;
          const bpLine = bp.location.range.start.line;
          return bpUri === file && bpLine === targetLine;
        }
        return false;
      });
      if (toRemove.length === 0) {
        return { success: false, error: `No breakpoint found at ${file}:${line}` };
      }
      vscode.debug.removeBreakpoints(toRemove);
      return { success: true, removed: toRemove.length };
    } catch (error) {
      return { success: false, error: `Failed to remove breakpoint: ${String(error)}` };
    }
  }

  listBreakpoints(): BreakpointInfo[] {
    const breakpoints: BreakpointInfo[] = [];
    for (const bp of vscode.debug.breakpoints) {
      if (bp instanceof vscode.SourceBreakpoint) {
        breakpoints.push({
          id: `${bp.location.uri.fsPath}:${bp.location.range.start.line + 1}`,
          file: bp.location.uri.fsPath,
          line: bp.location.range.start.line + 1,
          enabled: bp.enabled,
          condition: bp.condition,
          hitCondition: bp.hitCondition,
          logMessage: bp.logMessage
        });
      }
    }
    return breakpoints;
  }

  async getVariables(sessionId?: string, frameId?: number): Promise<GetVariablesResult> {
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
    const session = this.findSessionById(targetId);
    if (!session) {
      return { success: false, sessionId: targetId, error: 'Debug session not found' };
    }
    try {
      let targetFrameId = frameId;
      if (targetFrameId === undefined) {
        const threadId = info.stoppedThreadId;
        if (!threadId) {
          return { success: false, sessionId: targetId, error: 'No stopped thread ID available' };
        }
        const stackResponse = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
        if (!stackResponse.stackFrames || stackResponse.stackFrames.length === 0) {
          return { success: false, sessionId: targetId, error: 'No stack frames available' };
        }
        targetFrameId = stackResponse.stackFrames[0].id;
      }
      const scopesResponse = await session.customRequest('scopes', { frameId: targetFrameId });
      const scopes: ScopeInfo[] = [];
      for (const scope of scopesResponse.scopes || []) {
        const varsResponse = await session.customRequest('variables', { variablesReference: scope.variablesReference });
        const variables: VariableInfo[] = (varsResponse.variables || []).map((v: Record<string, unknown>) => ({
          name: v.name as string,
          value: v.value as string,
          type: v.type as string | undefined,
          variablesReference: (v.variablesReference as number) || 0
        }));
        scopes.push({
          name: scope.name as string,
          variablesReference: scope.variablesReference as number,
          variables
        });
      }
      return { success: true, sessionId: targetId, frameId: targetFrameId, scopes };
    } catch (error) {
      return { success: false, sessionId: targetId, error: `Failed to get variables: ${String(error)}` };
    }
  }

  async evaluate(expression: string, sessionId?: string, frameId?: number): Promise<EvaluateResult> {
    const targetId = sessionId || vscode.debug.activeDebugSession?.id;
    if (!targetId) {
      return { success: false, error: 'No active debug session' };
    }
    const info = this.sessions.get(targetId);
    if (!info) {
      return { success: false, error: 'Session not found' };
    }
    if (info.state !== 'paused') {
      return { success: false, error: `Session is not paused (state: ${info.state})` };
    }
    const session = this.findSessionById(targetId);
    if (!session) {
      return { success: false, error: 'Debug session not found' };
    }
    try {
      let targetFrameId = frameId;
      if (targetFrameId === undefined) {
        const threadId = info.stoppedThreadId;
        if (!threadId) {
          return { success: false, error: 'No stopped thread ID available' };
        }
        const stackResponse = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
        if (!stackResponse.stackFrames || stackResponse.stackFrames.length === 0) {
          return { success: false, error: 'No stack frames available' };
        }
        targetFrameId = stackResponse.stackFrames[0].id;
      }
      const response = await session.customRequest('evaluate', {
        expression,
        frameId: targetFrameId,
        context: 'repl'
      });
      return {
        success: true,
        result: response.result as string,
        type: response.type as string | undefined,
        variablesReference: (response.variablesReference as number) || 0
      };
    } catch (error) {
      return { success: false, error: `Evaluation failed: ${String(error)}` };
    }
  }

  async continueExecution(sessionId?: string, threadId?: number): Promise<ContinueResult> {
    const targetId = sessionId || vscode.debug.activeDebugSession?.id;
    if (!targetId) {
      return { success: false, error: 'No active debug session' };
    }
    const info = this.sessions.get(targetId);
    if (!info) {
      return { success: false, error: 'Session not found' };
    }
    if (info.state !== 'paused') {
      return { success: false, error: `Session is not paused (state: ${info.state})` };
    }
    const session = this.findSessionById(targetId);
    if (!session) {
      return { success: false, error: 'Debug session not found' };
    }
    try {
      const targetThreadId = threadId || info.stoppedThreadId;
      if (!targetThreadId) {
        return { success: false, error: 'No thread ID available' };
      }
      const response = await session.customRequest('continue', { threadId: targetThreadId });
      return {
        success: true,
        allThreadsContinued: response.allThreadsContinued as boolean | undefined
      };
    } catch (error) {
      return { success: false, error: `Failed to continue: ${String(error)}` };
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.sessions.clear();
    this.outputs.clear();
    this.outputLengths.clear();
    this.outputTruncated.clear();
    this.outputLimits.clear();
    this.pendingOutputLimits.clear();
    this.pendingConsoleOverrides.clear();
  }
}
