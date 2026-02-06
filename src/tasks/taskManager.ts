import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as jsonc from 'jsonc-parser';

export interface PickStringOption {
  label: string;
  value: string;
}

export interface TaskInputDefinition {
  id: string;
  type: 'promptString' | 'pickString' | 'command';
  description?: string;
  default?: string;
  options?: (string | PickStringOption)[];
}

export interface McpOptions {
  returnOutput?: 'always' | 'onFailure' | 'never';
  outputLimit?: number | null;
  interactive?: boolean;
}

export interface TaskInfo {
  name: string;
  source: string;
  type: string;
  scope?: string;
  isBackground: boolean;
  detail?: string;
  inputs?: TaskInputDefinition[];
  rawCommand?: string;
  mcpOptions?: McpOptions;
  dependsOn?: string[];
}

export interface TaskExecutionInfo {
  executionId: string;
  taskName: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: number;
  endTime?: number;
  exitCode?: number;
}

export interface TaskRunResult {
  success: boolean;
  executionId?: string;
  error?: string;
}

export interface TaskStatusResult {
  found: boolean;
  execution?: TaskExecutionInfo;
}

export interface TaskOutputResult {
  found: boolean;
  output?: string;
  truncated?: boolean;
  error?: string;
}

export interface TaskCancelResult {
  success: boolean;
  error?: string;
}

export interface TaskAwaitResult {
  success: boolean;
  executionId: string;
  status?: TaskExecutionInfo['status'];
  exitCode?: number;
  output?: string;
  truncated?: boolean;
  error?: string;
}

interface ShellConfig {
  executable?: string;
  args?: string[];
}

class OutputCapturePty implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number>();
  onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  onDidClose: vscode.Event<number> = this.closeEmitter.event;
  private outputBuffer: string[] = [];
  private childProcess: cp.ChildProcess | null = null;
  private onOutputCallback?: (output: string) => void;
  private onExitCallback?: (code: number) => void;

  constructor(
    private command: string,
    private cwd: string,
    private env: NodeJS.ProcessEnv,
    onOutput: (output: string) => void,
    onExit: (code: number) => void,
    private shellConfig?: ShellConfig
  ) {
    this.onOutputCallback = onOutput;
    this.onExitCallback = onExit;
  }

  open(): void {
    const defaultShell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const defaultArgs = process.platform === 'win32' ? ['/c', this.command] : ['-c', this.command];
    
    const shell = this.shellConfig?.executable || defaultShell;
    // If custom shell args provided, append command; otherwise use defaults
    const shellArgs = this.shellConfig?.args 
      ? [...this.shellConfig.args, this.command]
      : defaultArgs;
    
    this.childProcess = cp.spawn(shell, shellArgs, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const handleData = (data: Buffer) => {
      const text = data.toString();
      this.outputBuffer.push(text);
      this.onOutputCallback?.(this.outputBuffer.join(''));
      const displayText = text.replace(/\n/g, '\r\n');
      this.writeEmitter.fire(displayText);
    };
    this.childProcess.stdout?.on('data', handleData);
    this.childProcess.stderr?.on('data', handleData);
    this.childProcess.on('exit', (code) => {
      const exitCode = code ?? 0;
      this.onExitCallback?.(exitCode);
    });
    this.childProcess.on('close', (code) => {
      const exitCode = code ?? 0;
      this.closeEmitter.fire(exitCode);
    });
    this.childProcess.on('error', (err) => {
      const errMsg = `Error: ${err.message}\r\n`;
      this.outputBuffer.push(errMsg);
      this.onOutputCallback?.(this.outputBuffer.join(''));
      this.writeEmitter.fire(errMsg);
      this.onExitCallback?.(-1);
      this.closeEmitter.fire(-1);
    });
  }

  close(): void {
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill();
    }
  }

  getOutput(): string {
    return this.outputBuffer.join('');
  }
}

export class TaskManager implements vscode.Disposable {
  private executions: Map<string, TaskExecutionInfo> = new Map();
  private outputs: Map<string, string> = new Map();
  private outputTruncated: Map<string, boolean> = new Map();
  private outputLimits: Map<string, number | null> = new Map();
  private activeExecutions: Map<string, vscode.TaskExecution> = new Map();
  private executionToId: Map<vscode.TaskExecution, string> = new Map();
  private interactiveExecutionIds: Set<string> = new Set();
  private disposables: vscode.Disposable[] = [];
  private outputChannel: vscode.OutputChannel | null = null;

  constructor() {
    this.disposables.push(
      vscode.tasks.onDidStartTask((e) => this.onTaskStarted(e)),
      vscode.tasks.onDidEndTask((e) => this.onTaskEnded(e)),
      vscode.tasks.onDidEndTaskProcess((e) => this.onTaskProcessEnded(e))
    );
  }

  setOutputChannel(channel: vscode.OutputChannel) {
    this.outputChannel = channel;
  }

  private log(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    const fullMessage = `[${timestamp}] [TaskManager] ${message}`;
    this.outputChannel?.appendLine(fullMessage);
    console.log(fullMessage);
  }

  private getDefaultOutputLimit(): number | null {
    const config = vscode.workspace.getConfiguration('ignition-mcp');
    return config.get<number | null>('outputLimit', 20480);
  }

  private getOutputLimitForExecution(executionId: string): number | null {
    const limit = this.outputLimits.get(executionId);
    return limit !== undefined ? limit : this.getDefaultOutputLimit();
  }

  private truncateOutput(output: string, executionId: string): string {
    const limit = this.getOutputLimitForExecution(executionId);
    if (limit === null || output.length <= limit) {
      return output;
    }
    this.outputTruncated.set(executionId, true);
    const truncationMsg = `\n\n[Output truncated: showing first ${limit} of ${output.length} characters]`;
    return output.slice(0, limit) + truncationMsg;
  }

  async listTasks(): Promise<TaskInfo[]> {
    this.log(`listTasks called`);
    const tasks = await vscode.tasks.fetchTasks();
    this.log(`Found ${tasks.length} VS Code tasks`);
    const tasksJsonData = this.readTasksJson();
    const inputDefinitions = tasksJsonData?.inputs || [];
    const rawTasks = tasksJsonData?.tasks || [];
    this.log(`Read ${rawTasks.length} tasks from tasks.json`);
    return tasks.map((task) => {
      const rawCommand = this.getRawCommand(task);
      const usedInputIds = this.findInputReferences(rawCommand);
      const inputs = usedInputIds.length > 0
        ? inputDefinitions.filter((inp: TaskInputDefinition) => usedInputIds.includes(inp.id))
        : undefined;
      const rawTaskEntry = rawTasks.find((t) => t.label === task.name);
      const mcpOptions = rawTaskEntry?.options?.mcp;
      if (mcpOptions) {
        this.log(`Task "${task.name}" has mcpOptions: ${JSON.stringify(mcpOptions)}`);
      } else if (task.name === 'CRC Refresh') {
        this.log(`Task "CRC Refresh" found but NO mcpOptions. rawTaskEntry: ${JSON.stringify(rawTaskEntry)}`);
        this.log(`Task object keys: ${Object.keys(task)}`);
        this.log(`Task definition: ${JSON.stringify(task.definition)}`);
        const exec = task.execution;
        if (exec && 'options' in exec) {
          this.log(`Execution options: ${JSON.stringify((exec as { options?: unknown }).options)}`);
        }
      }
      const dependsOnRaw = rawTaskEntry?.dependsOn;
      const dependsOn = dependsOnRaw 
        ? (Array.isArray(dependsOnRaw) ? dependsOnRaw : [dependsOnRaw])
        : undefined;
      return {
        name: task.name,
        source: task.source,
        type: task.definition.type,
        scope: this.getScopeName(task.scope),
        isBackground: task.isBackground,
        detail: task.detail,
        inputs,
        rawCommand: usedInputIds.length > 0 ? rawCommand : undefined,
        mcpOptions,
        dependsOn
      };
    });
  }

  async getTask(taskName: string): Promise<vscode.Task | undefined> {
    const tasks = await vscode.tasks.fetchTasks();
    return tasks.find((t) => t.name === taskName);
  }

  async getTaskByName(taskName: string): Promise<TaskInfo | undefined> {
    const tasks = await this.listTasks();
    return tasks.find((t) => t.name === taskName);
  }

  async collectAllInputs(taskName: string, visited: Set<string> = new Set()): Promise<TaskInputDefinition[]> {
    if (visited.has(taskName)) {
      return [];
    }
    visited.add(taskName);
    const task = await this.getTaskByName(taskName);
    if (!task) {
      return [];
    }
    const allInputs: TaskInputDefinition[] = [];
    const seenIds = new Set<string>();
    if (task.dependsOn) {
      for (const depName of task.dependsOn) {
        const depInputs = await this.collectAllInputs(depName, visited);
        for (const input of depInputs) {
          if (!seenIds.has(input.id)) {
            seenIds.add(input.id);
            allInputs.push(input);
          }
        }
      }
    }
    if (task.inputs) {
      for (const input of task.inputs) {
        if (!seenIds.has(input.id)) {
          seenIds.add(input.id);
          allInputs.push(input);
        }
      }
    }
    return allInputs;
  }

  private readTasksJson(): { 
    inputs?: TaskInputDefinition[]; 
    tasks?: Array<{ label?: string; options?: { mcp?: McpOptions }; dependsOn?: string | string[] }> 
  } | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this.log('readTasksJson: No workspace folders');
      return null;
    }
    const tasksJsonPath = path.join(workspaceFolders[0].uri.fsPath, '.vscode', 'tasks.json');
    if (!fs.existsSync(tasksJsonPath)) {
      this.log(`readTasksJson: tasks.json not found at ${tasksJsonPath}`);
      return null;
    }
    try {
      const content = fs.readFileSync(tasksJsonPath, 'utf-8');
      const errors: jsonc.ParseError[] = [];
      const parsed = jsonc.parse(content, errors, { allowTrailingComma: true });
      if (errors.length > 0) {
        this.log(`readTasksJson: JSONC parse warnings: ${errors.map(e => jsonc.printParseErrorCode(e.error)).join(', ')}`);
      }
      this.log(`readTasksJson: Successfully parsed tasks.json from ${tasksJsonPath}`);
      const tasksWithMcp = parsed?.tasks?.filter((t: { options?: { mcp?: McpOptions } }) => t.options?.mcp);
      if (tasksWithMcp?.length > 0) {
        this.log(`Tasks with mcp options: ${tasksWithMcp.map((t: { label?: string }) => t.label).join(', ')}`);
      }
      return parsed;
    } catch (err) {
      this.log(`readTasksJson: Error parsing tasks.json: ${err}`);
      return null;
    }
  }

  private getRawCommand(task: vscode.Task): string {
    const exec = task.execution;
    if (!exec) return '';
    if (exec instanceof vscode.ShellExecution) {
      if (exec.commandLine) {
        return exec.commandLine;
      }
      if (exec.command) {
        const cmd = typeof exec.command === 'string' ? exec.command : exec.command.value;
        const args = exec.args?.map(a => typeof a === 'string' ? a : a.value).join(' ') || '';
        return args ? `${cmd} ${args}` : cmd;
      }
    }
    if (exec instanceof vscode.ProcessExecution) {
      const args = exec.args?.join(' ') || '';
      return args ? `${exec.process} ${args}` : exec.process;
    }
    return '';
  }

  private findInputReferences(command: string): string[] {
    const regex = /\$\{input:([^}]+)\}/g;
    const matches: string[] = [];
    let match;
    while ((match = regex.exec(command)) !== null) {
      if (!matches.includes(match[1])) {
        matches.push(match[1]);
      }
    }
    return matches;
  }

  private getScopeName(scope: vscode.TaskScope | vscode.WorkspaceFolder | undefined): string | undefined {
    if (scope === vscode.TaskScope.Global) return 'global';
    if (scope === vscode.TaskScope.Workspace) return 'workspace';
    if (scope && typeof scope === 'object' && 'name' in scope) return scope.name;
    return undefined;
  }

  async runTask(taskName: string, inputValues?: Record<string, string>, mcpOptions?: McpOptions): Promise<TaskRunResult> {
    this.log(`runTask called for "${taskName}" with mcpOptions: ${JSON.stringify(mcpOptions)}`);
    const tasks = await vscode.tasks.fetchTasks();
    const task = tasks.find((t) => t.name === taskName);
    if (!task) {
      return { success: false, error: `Task "${taskName}" not found` };
    }
    try {
      const executionId = this.generateExecutionId();
      const executionInfo: TaskExecutionInfo = {
        executionId,
        taskName,
        status: 'running',
        startTime: Date.now()
      };
      this.executions.set(executionId, executionInfo);
      this.outputs.set(executionId, '');
      if (mcpOptions?.outputLimit !== undefined) {
        this.outputLimits.set(executionId, mcpOptions.outputLimit);
      }
      if (mcpOptions?.interactive) {
        this.log(`Running task "${taskName}" in INTERACTIVE mode`);
        return this.runTaskInteractive(task, executionId, inputValues);
      }
      this.log(`Running task "${taskName}" in CAPTURE mode`);
      let rawCommand = this.getRawCommand(task);
      if (inputValues && Object.keys(inputValues).length > 0) {
        for (const [inputId, value] of Object.entries(inputValues)) {
          const pattern = new RegExp(`\\$\\{input:${inputId}\\}`, 'g');
          rawCommand = rawCommand.replace(pattern, value);
        }
      }
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const defaultCwd = workspaceFolder?.uri.fsPath || process.cwd();
      
      // Extract options from ShellExecution if available
      const exec = task.execution;
      let taskCwd = defaultCwd;
      let taskEnv: NodeJS.ProcessEnv = { ...process.env };
      let shellConfig: ShellConfig | undefined;
      
      if (exec instanceof vscode.ShellExecution && exec.options) {
        // Use task's cwd if specified, resolving variables
        if (exec.options.cwd) {
          taskCwd = this.resolveVariables(exec.options.cwd, workspaceFolder);
        }
        // Merge task's env with process.env (task env takes precedence)
        if (exec.options.env) {
          taskEnv = { ...process.env, ...exec.options.env };
        }
        // Extract shell configuration
        if (exec.options.executable) {
          shellConfig = {
            executable: exec.options.executable,
            args: exec.options.shellArgs
          };
        }
      }
      
      const resolvedCommand = this.resolveVariables(rawCommand, workspaceFolder);
      const customExec = new vscode.CustomExecution(async () => {
        return new OutputCapturePty(
          resolvedCommand,
          taskCwd,
          taskEnv,
          (output) => { this.outputs.set(executionId, this.truncateOutput(output, executionId)); },
          (exitCode) => {
            const info = this.executions.get(executionId);
            if (info) {
              info.exitCode = exitCode;
              info.status = exitCode === 0 ? 'completed' : 'failed';
              info.endTime = Date.now();
            }
            this.activeExecutions.delete(executionId);
          },
          shellConfig
        );
      });
      const captureTask = new vscode.Task(
        task.definition,
        task.scope || vscode.TaskScope.Workspace,
        task.name,
        task.source,
        customExec,
        task.problemMatchers
      );
      captureTask.presentationOptions = task.presentationOptions;
      const execution = await vscode.tasks.executeTask(captureTask);
      this.activeExecutions.set(executionId, execution);
      return { success: true, executionId };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  private async runTaskInteractive(
    task: vscode.Task,
    executionId: string,
    inputValues?: Record<string, string>
  ): Promise<TaskRunResult> {
    try {
      let taskToRun: vscode.Task;
      if (inputValues && Object.keys(inputValues).length > 0) {
        // Need to substitute input values - create a modified task
        const rawCommand = this.getRawCommand(task);
        let resolvedCommand = rawCommand;
        for (const [inputId, value] of Object.entries(inputValues)) {
          const pattern = new RegExp(`\\$\\{input:${inputId}\\}`, 'g');
          resolvedCommand = resolvedCommand.replace(pattern, value);
        }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        resolvedCommand = this.resolveVariables(resolvedCommand, workspaceFolder);
        
        // Preserve original shell execution options (cwd, env, shell)
        const originalExec = task.execution;
        const shellOptions = originalExec instanceof vscode.ShellExecution ? originalExec.options : undefined;
        const shellExec = new vscode.ShellExecution(resolvedCommand, shellOptions);
        
        taskToRun = new vscode.Task(
          task.definition,
          task.scope || vscode.TaskScope.Workspace,
          task.name,
          task.source,
          shellExec,
          task.problemMatchers
        );
        taskToRun.presentationOptions = {
          ...task.presentationOptions,
          reveal: vscode.TaskRevealKind.Always,
          focus: true
        };
      } else {
        // No input substitution needed - use the original task directly
        // This preserves VS Code's internal task definition and avoids
        // issues where recreating the task loses the command
        taskToRun = task;
      }
      this.interactiveExecutionIds.add(executionId);
      const execution = await vscode.tasks.executeTask(taskToRun);
      this.activeExecutions.set(executionId, execution);
      this.executionToId.set(execution, executionId);
      this.outputs.set(executionId, '[Interactive mode: output not captured]');
      return { success: true, executionId };
    } catch (error) {
      this.interactiveExecutionIds.delete(executionId);
      return { success: false, error: String(error) };
    }
  }

  private resolveVariables(command: string, workspaceFolder?: vscode.WorkspaceFolder): string {
    let resolved = command;
    if (workspaceFolder) {
      resolved = resolved.replace(/\$\{workspaceFolder\}/g, workspaceFolder.uri.fsPath);
      resolved = resolved.replace(/\$\{workspaceFolderBasename\}/g, workspaceFolder.name);
    }
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const filePath = activeEditor.document.uri.fsPath;
      resolved = resolved.replace(/\$\{file\}/g, filePath);
      resolved = resolved.replace(/\$\{fileBasename\}/g, path.basename(filePath));
      resolved = resolved.replace(/\$\{fileBasenameNoExtension\}/g, path.basename(filePath, path.extname(filePath)));
      resolved = resolved.replace(/\$\{fileDirname\}/g, path.dirname(filePath));
      resolved = resolved.replace(/\$\{fileExtname\}/g, path.extname(filePath));
      resolved = resolved.replace(/\$\{relativeFile\}/g, 
        workspaceFolder ? path.relative(workspaceFolder.uri.fsPath, filePath) : filePath);
    }
    return resolved;
  }

  async runTaskAndWait(
    taskName: string,
    inputValues?: Record<string, string>,
    mcpOptions?: McpOptions,
    timeoutMs: number = 300000
  ): Promise<{
    success: boolean;
    executionId?: string;
    status?: TaskExecutionInfo['status'];
    exitCode?: number;
    output?: string;
    error?: string;
  }> {
    const result = await this.runTask(taskName, inputValues, mcpOptions);
    if (!result.success || !result.executionId) {
      return { success: false, error: result.error };
    }
    const executionId = result.executionId;
    return new Promise((resolve) => {
      const startTime = Date.now();
      const checkStatus = () => {
        const info = this.executions.get(executionId);
        if (!info) {
          resolve({ success: false, executionId, error: 'Execution info lost' });
          return;
        }
        if (info.status !== 'running') {
          const output = this.outputs.get(executionId);
          resolve({
            success: info.status === 'completed',
            executionId,
            status: info.status,
            exitCode: info.exitCode,
            output
          });
          return;
        }
        if (Date.now() - startTime > timeoutMs) {
          resolve({
            success: false,
            executionId,
            status: 'running',
            error: `Task timed out after ${timeoutMs}ms (still running)`
          });
          return;
        }
        setTimeout(checkStatus, 100);
      };
      checkStatus();
    });
  }

  getTaskStatus(executionId: string): TaskStatusResult {
    const execution = this.executions.get(executionId);
    if (!execution) {
      return { found: false };
    }
    return { found: true, execution };
  }

  getTaskOutput(executionId: string): TaskOutputResult {
    if (!this.executions.has(executionId)) {
      return { found: false, error: 'Execution not found' };
    }
    const output = this.outputs.get(executionId);
    const truncated = this.outputTruncated.get(executionId);
    return { found: true, output: output || '', truncated };
  }

  cancelTask(executionId: string): TaskCancelResult {
    const execution = this.activeExecutions.get(executionId);
    if (!execution) {
      const info = this.executions.get(executionId);
      if (info && info.status !== 'running') {
        return { success: false, error: 'Task is not running' };
      }
      return { success: false, error: 'Execution not found' };
    }
    try {
      execution.terminate();
      const info = this.executions.get(executionId);
      if (info) {
        info.status = 'cancelled';
        info.endTime = Date.now();
      }
      this.activeExecutions.delete(executionId);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  private getDefaultAwaitTimeout(): number {
    const config = vscode.workspace.getConfiguration('ignition-mcp');
    return config.get<number>('awaitTimeout', 300000);
  }

  async awaitTask(executionId: string, timeoutMs?: number): Promise<TaskAwaitResult> {
    const info = this.executions.get(executionId);
    if (!info) {
      return { success: false, executionId, error: 'Execution not found' };
    }
    if (info.status !== 'running') {
      const output = this.outputs.get(executionId);
      const truncated = this.outputTruncated.get(executionId);
      return {
        success: info.status === 'completed',
        executionId,
        status: info.status,
        exitCode: info.exitCode,
        output,
        truncated
      };
    }
    const timeout = timeoutMs ?? this.getDefaultAwaitTimeout();
    return new Promise((resolve) => {
      const startTime = Date.now();
      const checkStatus = () => {
        const currentInfo = this.executions.get(executionId);
        if (!currentInfo) {
          resolve({ success: false, executionId, error: 'Execution info lost' });
          return;
        }
        if (currentInfo.status !== 'running') {
          const output = this.outputs.get(executionId);
          const truncated = this.outputTruncated.get(executionId);
          resolve({
            success: currentInfo.status === 'completed',
            executionId,
            status: currentInfo.status,
            exitCode: currentInfo.exitCode,
            output,
            truncated
          });
          return;
        }
        if (Date.now() - startTime > timeout) {
          resolve({
            success: false,
            executionId,
            status: 'running',
            error: `Await timed out after ${timeout}ms (task still running)`
          });
          return;
        }
        setTimeout(checkStatus, 100);
      };
      checkStatus();
    });
  }

  private onTaskStarted(e: vscode.TaskStartEvent) {
    this.log(`Task started: ${e.execution.task.name}`);
  }

  /**
   * Find execution ID for a task event.
   * VS Code may return different object references for the same execution,
   * so we fall back to matching by task name for running executions.
   */
  private findExecutionId(execution: vscode.TaskExecution): string | undefined {
    // First try direct object lookup
    const directId = this.executionToId.get(execution);
    if (directId) {
      return directId;
    }
    // Fall back to object identity check in activeExecutions
    for (const [id, exec] of this.activeExecutions) {
      if (exec === execution) {
        return id;
      }
    }
    // Final fallback: match by task name for running interactive executions
    // This handles cases where VS Code returns different object references
    const taskName = execution.task.name;
    for (const [id, info] of this.executions) {
      if (info.taskName === taskName && 
          info.status === 'running' && 
          this.interactiveExecutionIds.has(id)) {
        this.log(`Matched task "${taskName}" by name (object identity mismatch)`);
        return id;
      }
    }
    return undefined;
  }

  private onTaskEnded(e: vscode.TaskEndEvent) {
    const taskName = e.execution.task.name;
    this.log(`onTaskEnded fired for "${taskName}"`);
    const execId = this.findExecutionId(e.execution);
    if (execId) {
      this.log(`Found execution ID ${execId} for ended task "${taskName}"`);
      // Clean up tracking structures (only here, not in onTaskProcessEnded)
      this.activeExecutions.delete(execId);
      this.executionToId.delete(e.execution);
      this.interactiveExecutionIds.delete(execId);
      // Update status if not already set by onTaskProcessEnded
      const info = this.executions.get(execId);
      if (info && info.status === 'running') {
        info.status = 'completed';
        info.endTime = Date.now();
        this.log(`Updated status to 'completed' for execution ${execId}`);
      }
    } else {
      this.log(`No execution ID found for ended task "${taskName}" (may be external task)`);
    }
  }

  private onTaskProcessEnded(e: vscode.TaskProcessEndEvent) {
    const taskName = e.execution.task.name;
    this.log(`onTaskProcessEnded fired for "${taskName}" with exit code ${e.exitCode}`);
    const execId = this.findExecutionId(e.execution);
    if (execId) {
      this.log(`Found execution ID ${execId} for process-ended task "${taskName}"`);
      // Only update status/exitCode here - cleanup happens in onTaskEnded
      const info = this.executions.get(execId);
      if (info) {
        info.exitCode = e.exitCode;
        if (info.status === 'running') {
          info.status = e.exitCode === 0 ? 'completed' : 'failed';
          info.endTime = Date.now();
          this.log(`Updated status to '${info.status}' with exit code ${e.exitCode} for execution ${execId}`);
        }
      }
      // Don't clean up here - let onTaskEnded do it to avoid race condition
    } else {
      this.log(`No execution ID found for process-ended task "${taskName}" (may be external task)`);
    }
  }

  private generateExecutionId(): string {
    return `exec-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.executions.clear();
    this.outputs.clear();
    this.outputTruncated.clear();
    this.outputLimits.clear();
    this.activeExecutions.clear();
    this.executionToId.clear();
    this.interactiveExecutionIds.clear();
  }
}
