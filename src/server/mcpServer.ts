import * as http from 'http';
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
  }

  private async registerTaskTools() {
    const tasks = await this.taskManager.listTasks();
    for (const task of tasks) {
      this.registerTaskTool(task);
    }
    console.log(`Registered ${tasks.length} task tools`);
  }

  private buildInputSchema(inputs: InputDefinition[]): Record<string, z.ZodOptional<z.ZodString>> {
    const schema: Record<string, z.ZodOptional<z.ZodString>> = {};
    for (const input of inputs) {
      let zodField = z.string();
      const descParts: string[] = [];
      if (input.description) {
        descParts.push(input.description);
      }
      if (input.type === 'pickString' && input.options) {
        descParts.push(`Options: ${input.options.join(', ')}`);
      }
      if (input.default) {
        descParts.push(`Default: ${input.default}`);
      }
      descParts.push('(optional - omit to prompt user)');
      zodField = zodField.describe(descParts.join('. '));
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

  private registerTaskTool(task: TaskInfo) {
    const toolName = this.sanitizeToolName(task.name, 'task_');
    const isBackground = task.isBackground;
    const description = this.buildTaskDescription(task);
    const hasInputs = task.inputs && task.inputs.length > 0;
    const inputSchema = hasInputs ? this.buildInputSchema(task.inputs!) : {};
    const returnOutputSetting = task.mcpOptions?.returnOutput;
    this.mcpServer.tool(
      toolName,
      description,
      inputSchema,
      async (params: Record<string, string | undefined>) => {
        let inputValues: Record<string, string> | undefined;
        let userWillBePrompted = false;
        if (hasInputs) {
          const resolved = this.resolveInputValues(task.inputs!, params);
          if (resolved.complete) {
            inputValues = resolved.values;
          } else {
            inputValues = undefined;
            userWillBePrompted = true;
          }
        }
        if (isBackground) {
          const result = await this.taskManager.runTask(task.name, inputValues);
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
            message: `Background task "${task.name}" started. Use get_task_status or get_task_output with the executionId to check progress.`,
            executionId: result.executionId,
            isBackground: true
          };
          if (userWillBePrompted) {
            response.note = 'User will be prompted for missing input values in VS Code.';
          }
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(response, null, 2)
            }]
          };
        } else {
          if (userWillBePrompted) {
            const result = await this.taskManager.runTask(task.name, inputValues);
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
          const result = await this.taskManager.runTaskAndWait(task.name, inputValues);
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
    if (task.inputs && task.inputs.length > 0) {
      const inputNames = task.inputs.map(i => i.id).join(', ');
      parts.push(`Inputs: ${inputNames} (all optional - omit any to prompt user)`);
    }
    return parts.join(' ');
  }

  private async registerLaunchTools() {
    const configs = await this.launchManager.listLaunchConfigs();
    for (const config of configs) {
      this.registerLaunchTool(config);
    }
    console.log(`Registered ${configs.length} launch tools`);
  }

  private registerLaunchTool(config: LaunchInfo) {
    const toolName = this.sanitizeToolName(config.name, 'launch_');
    const description = this.buildLaunchDescription(config);
    const hasInputs = config.inputs && config.inputs.length > 0;
    const inputSchema = hasInputs ? this.buildInputSchema(config.inputs!) : {};
    this.mcpServer.tool(
      toolName,
      description,
      inputSchema,
      async (params: Record<string, string | undefined>) => {
        let inputValues: Record<string, string> | undefined;
        let userWillBePrompted = false;
        if (hasInputs) {
          const resolved = this.resolveInputValues(config.inputs!, params);
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
          note: 'Use get_debug_status to check session state, get_debug_output for console output, get_stack_trace when paused.'
        };
        if (result.consoleOverridden) {
          response.consoleOverridden = true;
          response.consoleNote = 'Console mode was changed to internalConsole for output capture.';
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
    const parts: string[] = [];
    parts.push(`Start VS Code debug session "${config.name}"`);
    parts.push(`[type: ${config.type}, request: ${config.request}]`);
    if (config.preLaunchTask) {
      parts.push(`(runs "${config.preLaunchTask}" first)`);
    }
    parts.push('(debug sessions are long-running, returns immediately)');
    if (config.inputs && config.inputs.length > 0) {
      const inputNames = config.inputs.map(i => i.id).join(', ');
      parts.push(`Inputs: ${inputNames} (all optional - omit any to prompt user)`);
    }
    return parts.join(' ');
  }

  async start(): Promise<void> {
    await this.registerTools();
    // Create the streamable HTTP transport
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
    });
    // Connect the MCP server to the transport
    await this.mcpServer.connect(this.transport);
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        const url = new URL(req.url || '/', `http://localhost:${this.port}`);
        if (url.pathname === '/mcp') {
          await this.handleMcp(req, res);
        } else if (url.pathname === '/health' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', server: 'ignition-mcp' }));
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
        console.log(`MCP server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.transport) {
      res.writeHead(500);
      res.end('Transport not initialized');
      return;
    }
    try {
      await this.transport.handleRequest(req, res);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal server error');
      }
    }
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
