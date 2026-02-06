import * as http from 'http';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { TaskManager, TaskInfo, TaskInputDefinition } from '../tasks/taskManager';
import { LaunchManager, LaunchInfo, LaunchInputDefinition } from '../launch/launchManager';

type InputDefinition = TaskInputDefinition | LaunchInputDefinition;

export type ShutdownCallback = () => void;

export class MCPServer {
  private server: http.Server | null = null;
  private mcpServer: McpServer;
  private transport: StreamableHTTPServerTransport | null = null;
  private port: number;
  private taskManager: TaskManager;
  private launchManager: LaunchManager;
  private onShutdownRequested?: ShutdownCallback;
  private outputChannel: vscode.OutputChannel | null = null;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;

  constructor(
    taskManager: TaskManager,
    launchManager: LaunchManager,
    port: number,
    onShutdownRequested?: ShutdownCallback
  ) {
    this.taskManager = taskManager;
    this.launchManager = launchManager;
    this.port = port;
    this.onShutdownRequested = onShutdownRequested;
    this.mcpServer = new McpServer({
      name: 'ignition-mcp',
      version: '0.1.0'
    });
    // Promise that resolves when transport is ready
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  setOutputChannel(channel: vscode.OutputChannel) {
    this.outputChannel = channel;
  }

  private log(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    const fullMessage = `[${timestamp}] [MCPServer] ${message}`;
    this.outputChannel?.appendLine(fullMessage);
    console.log(fullMessage);
  }

  private sanitizeToolName(name: string, prefix: string): string {
    return prefix + name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  }

  private async registerTools() {
    this.registerUtilityTools();
    await this.registerTaskTools();
    await this.registerLaunchTools();
  }

  private registerUtilityTools() {
    this.mcpServer.tool(
      'list_tasks',
      'List all available VS Code tasks from the workspace with their metadata',
      {},
      async () => {
        const tasks = await this.taskManager.listTasks();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(tasks, null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'get_task_status',
      'Get the status of a task execution by its execution ID',
      { executionId: z.string().describe('The execution ID returned when a background task was started') },
      async ({ executionId }) => {
        const status = this.taskManager.getTaskStatus(executionId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(status, null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'get_task_output',
      'Get the captured output from a task execution',
      { executionId: z.string().describe('The execution ID returned when a background task was started') },
      async ({ executionId }) => {
        const output = this.taskManager.getTaskOutput(executionId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(output, null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'cancel_task',
      'Cancel a running task',
      { executionId: z.string().describe('The execution ID returned when a task was started') },
      async ({ executionId }) => {
        const result = this.taskManager.cancelTask(executionId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'await_task',
      'Wait for a running task to complete. Returns when the task finishes (completed, failed, or cancelled) or times out.',
      {
        executionId: z.string().describe('The execution ID returned when the task was started'),
        timeoutMs: z.number().optional().describe('Timeout in milliseconds (default: 5 minutes from ignition-mcp.awaitTimeout setting)')
      },
      async ({ executionId, timeoutMs }) => {
        const result = await this.taskManager.awaitTask(executionId, timeoutMs);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2)
          }],
          isError: !result.success
        };
      }
    );
    this.mcpServer.tool(
      'list_launch_configs',
      'List all available VS Code launch configurations from the workspace',
      {},
      async () => {
        const configs = await this.launchManager.listLaunchConfigs();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(configs.map(c => ({
              name: c.name,
              type: c.type,
              request: c.request,
              preLaunchTask: c.preLaunchTask,
              inputs: c.inputs
            })), null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'get_debug_status',
      'Get the status of active debug sessions including state (running/paused/terminated), stop reason, and exception info',
      {},
      async () => {
        const status = this.launchManager.getDebugStatus();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(status, null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'get_debug_output',
      'Get the captured debug console output from a debug session',
      { sessionId: z.string().optional().describe('The session ID (omit to use the active session)') },
      async ({ sessionId }) => {
        const result = this.launchManager.getDebugOutput(sessionId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'get_stack_trace',
      'Get the call stack from a paused debug session',
      { sessionId: z.string().optional().describe('The session ID (omit to use the active session)') },
      async ({ sessionId }) => {
        const result = await this.launchManager.getStackTrace(sessionId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'stop_debug_session',
      'Stop a debug session',
      { sessionId: z.string().optional().describe('The session ID to stop (omit to stop the active session)') },
      async ({ sessionId }) => {
        const result = await this.launchManager.stopDebug(sessionId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'add_breakpoint',
      'Add a breakpoint at a specific file and line. The breakpoint will be visible in VS Code.',
      {
        file: z.string().describe('Absolute path to the source file'),
        line: z.number().describe('Line number (1-based)'),
        condition: z.string().optional().describe('Optional condition expression for conditional breakpoint')
      },
      async ({ file, line, condition }) => {
        const result = await this.launchManager.addBreakpoint(file, line, condition);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'remove_breakpoint',
      'Remove a breakpoint at a specific file and line',
      {
        file: z.string().describe('Absolute path to the source file'),
        line: z.number().describe('Line number (1-based)')
      },
      async ({ file, line }) => {
        const result = await this.launchManager.removeBreakpoint(file, line);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'list_breakpoints',
      'List all breakpoints currently set in VS Code',
      {},
      async () => {
        const breakpoints = this.launchManager.listBreakpoints();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(breakpoints, null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'get_variables',
      'Get variables from the current scope of a paused debug session. Returns local variables, closure variables, and globals.',
      {
        sessionId: z.string().optional().describe('The session ID (omit to use the active session)'),
        frameId: z.number().optional().describe('Stack frame ID (omit to use the topmost frame)')
      },
      async ({ sessionId, frameId }) => {
        const result = await this.launchManager.getVariables(sessionId, frameId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'evaluate',
      'Evaluate an expression in the context of a paused debug session',
      {
        expression: z.string().describe('The expression to evaluate'),
        sessionId: z.string().optional().describe('The session ID (omit to use the active session)'),
        frameId: z.number().optional().describe('Stack frame ID (omit to use the topmost frame)')
      },
      async ({ expression, sessionId, frameId }) => {
        const result = await this.launchManager.evaluate(expression, sessionId, frameId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'continue_execution',
      'Resume execution of a paused debug session',
      {
        sessionId: z.string().optional().describe('The session ID (omit to use the active session)'),
        threadId: z.number().optional().describe('Thread ID to continue (omit to use the stopped thread)')
      },
      async ({ sessionId, threadId }) => {
        const result = await this.launchManager.continueExecution(sessionId, threadId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'await_debug_event',
      'Wait for a debug session state change. Returns when the session pauses (breakpoint, exception, step), resumes, or terminates. Use in a loop to monitor session lifecycle.',
      {
        sessionId: z.string().optional().describe('The session ID (omit to use the active session)'),
        timeoutMs: z.number().optional().describe('Timeout in milliseconds (default: 5 minutes from ignition-mcp.awaitTimeout setting)')
      },
      async ({ sessionId, timeoutMs }) => {
        const result = await this.launchManager.awaitStateChange(sessionId, timeoutMs);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2)
          }],
          isError: !result.success
        };
      }
    );
  }

  private async registerTaskTools() {
    const tasks = await this.taskManager.listTasks();
    for (const task of tasks) {
      const allInputs = await this.taskManager.collectAllInputs(task.name);
      this.registerTaskTool(task, allInputs);
    }
    this.log(`Registered ${tasks.length} task tools`);
  }

  private buildInputSchema(inputs: InputDefinition[]): Record<string, z.ZodTypeAny> {
    const schema: Record<string, z.ZodTypeAny> = {};
    for (const input of inputs) {
      const descParts: string[] = [];
      if (input.description) {
        descParts.push(input.description);
      }
      let zodField: z.ZodTypeAny;
      if (input.type === 'pickString' && input.options && input.options.length > 0) {
        const literals: z.ZodLiteral<string>[] = [];
        for (const opt of input.options) {
          if (typeof opt === 'string') {
            literals.push(z.literal(opt).describe(opt));
          } else {
            literals.push(z.literal(opt.value).describe(opt.label));
          }
        }
        zodField = z.union(literals as [z.ZodLiteral<string>, z.ZodLiteral<string>, ...z.ZodLiteral<string>[]]);
      } else {
        zodField = z.string();
      }
      if (input.default) {
        descParts.push(`If omitted, user prompted with default "${input.default}".`);
      } else {
        descParts.push('If omitted, user will be prompted.');
      }
      if (descParts.length > 0) {
        zodField = zodField.describe(descParts.join(' '));
      }
      schema[input.id] = zodField.optional();
    }
    return schema;
  }

  private resolveInputValues(
    inputs: InputDefinition[],
    providedValues: Record<string, string | undefined>
  ): { complete: boolean; values: Record<string, string> } {
    const resolved: Record<string, string> = {};
    for (const input of inputs) {
      const provided = providedValues[input.id];
      if (provided !== undefined && provided !== '') {
        resolved[input.id] = provided;
      } else if (input.default !== undefined) {
        resolved[input.id] = input.default;
      } else {
        return { complete: false, values: {} };
      }
    }
    return { complete: true, values: resolved };
  }

  private shouldReturnOutput(
    returnOutputSetting: 'always' | 'onFailure' | 'never' | undefined,
    exitCode: number | undefined
  ): boolean {
    const setting = returnOutputSetting ?? 'onFailure';
    if (setting === 'always') return true;
    if (setting === 'never') return false;
    return exitCode !== 0;
  }

  private registerTaskTool(task: TaskInfo, allInputs: InputDefinition[]) {
    const toolName = this.sanitizeToolName(task.name, 'task_');
    const isBackground = task.isBackground;
    const isInteractive = task.mcpOptions?.interactive ?? false;
    const description = this.buildTaskDescription(task);
    const hasInputs = allInputs.length > 0;
    const inputSchema = hasInputs ? this.buildInputSchema(allInputs) : {};
    const returnOutputSetting = task.mcpOptions?.returnOutput;
    this.mcpServer.tool(
      toolName,
      description,
      inputSchema,
      async (params: Record<string, string | undefined>) => {
        let inputValues: Record<string, string> | undefined;
        let userWillBePrompted = false;
        if (hasInputs) {
          const resolved = this.resolveInputValues(allInputs, params);
          if (resolved.complete) {
            inputValues = resolved.values;
          } else {
            inputValues = undefined;
            userWillBePrompted = true;
          }
        }
        // Background tasks and interactive tasks both return immediately
        // Interactive tasks can't capture output and may run for arbitrary durations
        if (isBackground || isInteractive) {
          const result = await this.taskManager.runTask(task.name, inputValues, task.mcpOptions);
          if (!result.success) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ error: result.error }, null, 2)
              }],
              isError: true
            };
          }
          const response: Record<string, unknown> = {
            status: 'started',
            message: isInteractive 
              ? `Interactive task "${task.name}" started. Use await_task to wait for completion.`
              : `Background task "${task.name}" started. Use await_task to wait for completion.`,
            executionId: result.executionId,
            isBackground: isBackground,
            isInteractive: isInteractive
          };
          if (userWillBePrompted) {
            response.note = 'User will be prompted for missing input values in VS Code.';
          }
          if (isInteractive) {
            response.outputNote = 'Output not captured in interactive mode.';
          }
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(response, null, 2)
            }]
          };
        } else {
          if (userWillBePrompted) {
            const result = await this.taskManager.runTask(task.name, inputValues, task.mcpOptions);
            if (!result.success) {
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({ error: result.error }, null, 2)
                }],
                isError: true
              };
            }
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'started',
                  message: `Task "${task.name}" started. User is being prompted for input values in VS Code.`,
                  executionId: result.executionId,
                  userPrompted: true,
                  note: 'Use get_task_status to check when the task completes.'
                }, null, 2)
              }]
            };
          }
          const result = await this.taskManager.runTaskAndWait(task.name, inputValues, task.mcpOptions);
          const includeOutput = this.shouldReturnOutput(returnOutputSetting, result.exitCode);
          if (!result.success) {
            const response: Record<string, unknown> = {
              status: result.status || 'failed',
              error: result.error,
              exitCode: result.exitCode,
              executionId: result.executionId
            };
            if (includeOutput) {
              response.output = result.output;
            }
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(response, null, 2)
              }],
              isError: true
            };
          }
          const response: Record<string, unknown> = {
            status: 'completed',
            exitCode: result.exitCode,
            executionId: result.executionId
          };
          if (includeOutput) {
            response.output = result.output;
          }
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(response, null, 2)
            }]
          };
        }
      }
    );
  }

  private buildTaskDescription(task: TaskInfo): string {
    const parts: string[] = [];
    parts.push(`Run VS Code task "${task.name}"`);
    if (task.detail) {
      parts.push(`- ${task.detail}`);
    }
    parts.push(`[type: ${task.type}, source: ${task.source}]`);
    if (task.isBackground) {
      parts.push('(background task - starts and returns immediately, check status later)');
    } else {
      parts.push('(waits for completion and returns result)');
    }
    if (task.mcpOptions?.interactive) {
      parts.push('[INTERACTIVE: runs in native terminal for user input, output not captured]');
    }
    if (task.dependsOn && task.dependsOn.length > 0) {
      parts.push(`[depends on: ${task.dependsOn.join(', ')}]`);
    }
    return parts.join(' ');
  }

  private async registerLaunchTools() {
    const configs = await this.launchManager.listLaunchConfigs();
    for (const config of configs) {
      const allInputs = await this.collectLaunchInputs(config);
      this.registerLaunchTool(config, allInputs);
    }
    this.log(`Registered ${configs.length} launch tools`);
  }

  private async collectLaunchInputs(config: LaunchInfo): Promise<InputDefinition[]> {
    const allInputs: InputDefinition[] = [];
    const seenIds = new Set<string>();
    if (config.preLaunchTask) {
      const taskInputs = await this.taskManager.collectAllInputs(config.preLaunchTask);
      for (const input of taskInputs) {
        if (!seenIds.has(input.id)) {
          seenIds.add(input.id);
          allInputs.push(input);
        }
      }
    }
    if (config.inputs) {
      for (const input of config.inputs) {
        if (!seenIds.has(input.id)) {
          seenIds.add(input.id);
          allInputs.push(input);
        }
      }
    }
    return allInputs;
  }

  private registerLaunchTool(config: LaunchInfo, allInputs: InputDefinition[]) {
    const toolName = this.sanitizeToolName(config.name, 'launch_');
    const description = this.buildLaunchDescription(config);
    const hasInputs = allInputs.length > 0;
    const inputSchema = hasInputs ? this.buildInputSchema(allInputs) : {};
    this.mcpServer.tool(
      toolName,
      description,
      inputSchema,
      async (params: Record<string, string | undefined>) => {
        let inputValues: Record<string, string> | undefined;
        let userWillBePrompted = false;
        if (hasInputs) {
          const resolved = this.resolveInputValues(allInputs, params);
          if (resolved.complete) {
            inputValues = resolved.values;
          } else {
            inputValues = undefined;
            userWillBePrompted = true;
          }
        }
        const result = await this.launchManager.startDebug(config.name, inputValues);
        if (!result.success) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: result.error }, null, 2)
            }],
            isError: true
          };
        }
        const response: Record<string, unknown> = {
          status: 'started',
          message: `Debug session "${config.name}" started.`,
          sessionId: result.sessionId,
          note: 'Use await_debug_event to wait for state changes (breakpoint, exception, or termination).'
        };
        if (result.consoleOverridden) {
          response.consoleOverridden = true;
          response.consoleNote = 'Console mode was changed to internalConsole for output capture.';
        }
        if (config.mcpOptions?.preserveConsole) {
          response.outputNotCaptured = true;
          response.outputNote = 'Output runs in terminal for human visibility. get_debug_output will not return results.';
        }
        if (userWillBePrompted) {
          response.userPrompted = true;
          response.note = 'User will be prompted for missing input values in VS Code. Use get_debug_status to check session state.';
        }
        if (config.preLaunchTask) {
          response.preLaunchTask = config.preLaunchTask;
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(response, null, 2)
          }]
        };
      }
    );
  }

  private buildLaunchDescription(config: LaunchInfo): string {
    const raw = config.rawConfig || {};
    const parts: string[] = [];
    parts.push(this.buildLaunchPurpose(config, raw));
    const hints = this.extractLaunchHints(raw);
    if (hints.length > 0) {
      parts.push(hints.join('. ') + '.');
    }
    if (config.preLaunchTask) {
      parts.push(`Runs "${config.preLaunchTask}" task first.`);
    }
    parts.push('(starts and returns immediately)');
    if (config.mcpOptions?.preserveConsole) {
      parts.push('[OUTPUT NOT CAPTURED: runs in terminal for human visibility]');
    }
    return parts.join(' ');
  }

  private buildLaunchPurpose(config: LaunchInfo, raw: Record<string, unknown>): string {
    const lang = this.getLaunchLanguage(config.type);
    const mode = raw['mode'] as string | undefined;
    const module = raw['module'] as string | undefined;
    if (config.request === 'attach') {
      if (mode === 'remote') {
        return `Attach to remote ${lang} process.`;
      }
      return `Attach to ${lang} process.`;
    }
    if (mode === 'test') {
      const program = raw['program'] as string | undefined;
      if (program?.includes('${fileDirname}')) {
        return `Debug ${lang} tests in current package.`;
      }
      return `Debug ${lang} tests.`;
    }
    if (module === 'pytest') {
      return `Debug Python pytest tests.`;
    }
    if (module) {
      return `Debug Python module "${module}".`;
    }
    return `Debug ${lang} program.`;
  }

  private getLaunchLanguage(type: string): string {
    const langMap: Record<string, string> = {
      'go': 'Go',
      'debugpy': 'Python',
      'python': 'Python',
      'node': 'Node.js',
      'pwa-node': 'Node.js',
      'cppdbg': 'C/C++',
      'lldb': 'C/C++',
      'coreclr': '.NET',
      'java': 'Java',
      'rust': 'Rust',
    };
    return langMap[type] || type;
  }

  private extractLaunchHints(raw: Record<string, unknown>): string[] {
    const hints: string[] = [];
    const substitutePath = raw['substitutePath'] as Array<{ from?: string; to?: string }> | undefined;
    if (substitutePath && substitutePath.length > 0) {
      const firstMapping = substitutePath[0];
      if (firstMapping.to) {
        hints.push(`Workspace mapped to ${firstMapping.to}`);
      }
    }
    if (raw['justMyCode'] === false) {
      hints.push('Steps into library code');
    }
    const env = raw['env'] as Record<string, string> | undefined;
    if (env && Object.keys(env).length > 0) {
      hints.push('Custom environment variables');
    }
    return hints;
  }

  async start(): Promise<void> {
    // Start HTTP server listening FIRST, so the port is available immediately
    // MCP requests will get 503 until tools are registered and transport is connected
    await new Promise<void>((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${this.port}`);
        this.log(`HTTP ${req.method} ${url.pathname}`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (url.pathname === '/mcp') {
          await this.handleMcp(req, res);
        } else if (url.pathname === '/health' && req.method === 'GET') {
          const status = this.transport ? 'ok' : 'initializing';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status, server: 'ignition-mcp' }));
        } else if (url.pathname === '/shutdown' && req.method === 'POST') {
          await this.handleShutdown(req, res);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });
      this.server.on('error', (err) => {
        reject(err);
      });
      // Explicitly listen on 0.0.0.0 to ensure both IPv4 and IPv6 work via loopback
      this.server.listen(this.port, '0.0.0.0', () => {
        this.log(`MCP server listening on port ${this.port}`);
        resolve();
      });
    });
    // Register tools - this can take a few seconds due to task discovery
    // Must happen BEFORE connecting to transport (SDK requirement)
    await this.registerTools();
    // Create the streamable HTTP transport and connect
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
    });
    await this.mcpServer.connect(this.transport);
    this.log('MCP transport connected, ready for requests');
    // Signal that we're ready - unblocks any waiting requests
    this.resolveReady();
  }

  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
    // Wait for transport to be ready if not yet initialized
    if (!this.transport) {
      this.log('MCP request received while initializing - waiting for ready...');
      await this.readyPromise;
      this.log('Server now ready, processing deferred request');
    }
    const startTime = Date.now();
    try {
      // For POST requests, check if this is a re-initialization attempt
      if (req.method === 'POST') {
        const body = await this.readRequestBody(req);
        const parsedBody = JSON.parse(body);
        // Check if this is an initialize request while we're already initialized
        if (this.isInitializeRequest(parsedBody) && this.transport!.sessionId) {
          this.log('Received initialize request while already initialized - recreating transport');
          await this.recreateTransport();
        }
        // Pass the pre-parsed body to avoid re-reading the stream
        // Use this.transport! to get the current transport (may have been recreated)
        await this.transport!.handleRequest(req, res, parsedBody);
      } else {
        await this.transport!.handleRequest(req, res);
      }
      this.log(`MCP request completed in ${Date.now() - startTime}ms`);
    } catch (error) {
      this.log(`MCP request failed after ${Date.now() - startTime}ms: ${error}`);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal server error');
      }
    }
  }

  private async readRequestBody(req: http.IncomingMessage): Promise<string> {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    return body;
  }

  private isInitializeRequest(body: unknown): boolean {
    // Handle both single request and batch request formats
    if (Array.isArray(body)) {
      return body.some(msg => msg?.method === 'initialize');
    }
    return (body as { method?: string })?.method === 'initialize';
  }

  private async recreateTransport(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
    }
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
    });
    await this.mcpServer.connect(this.transport);
  }

  private async handleShutdown(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    try {
      const data = JSON.parse(body) as { requester?: string };
      if (data.requester !== 'ignition-mcp') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid requester' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'shutting_down' }));
      // Trigger shutdown callback after response is sent
      if (this.onShutdownRequested) {
        setImmediate(() => this.onShutdownRequested!());
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
  }

  async stop(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
