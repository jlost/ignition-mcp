import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface TaskInputDefinition {
  id: string;
  type: 'promptString' | 'pickString' | 'command';
  description?: string;
  default?: string;
  options?: string[];
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
  error?: string;
}

export interface TaskCancelResult {
  success: boolean;
  error?: string;
}

export class TaskManager implements vscode.Disposable {
  private executions: Map<string, TaskExecutionInfo> = new Map();
  private outputs: Map<string, string> = new Map();
  private activeExecutions: Map<string, vscode.TaskExecution> = new Map();
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.tasks.onDidStartTask((e) => this.onTaskStarted(e)),
      vscode.tasks.onDidEndTask((e) => this.onTaskEnded(e)),
      vscode.tasks.onDidEndTaskProcess((e) => this.onTaskProcessEnded(e))
    );
  }

  async listTasks(): Promise<TaskInfo[]> {
    const tasks = await vscode.tasks.fetchTasks();
    const tasksJsonData = this.readTasksJson();
    const inputDefinitions = tasksJsonData?.inputs || [];
    return tasks.map((task) => {
      const rawCommand = this.getRawCommand(task);
      const usedInputIds = this.findInputReferences(rawCommand);
      const inputs = usedInputIds.length > 0
        ? inputDefinitions.filter((inp: TaskInputDefinition) => usedInputIds.includes(inp.id))
        : undefined;
      return {
        name: task.name,
        source: task.source,
        type: task.definition.type,
        scope: this.getScopeName(task.scope),
        isBackground: task.isBackground,
        detail: task.detail,
        inputs,
        rawCommand: usedInputIds.length > 0 ? rawCommand : undefined
      };
    });
  }

  async getTask(taskName: string): Promise<vscode.Task | undefined> {
    const tasks = await vscode.tasks.fetchTasks();
    return tasks.find((t) => t.name === taskName);
  }

  private readTasksJson(): { inputs?: TaskInputDefinition[]; tasks?: unknown[] } | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }
    const tasksJsonPath = path.join(workspaceFolders[0].uri.fsPath, '.vscode', 'tasks.json');
    if (!fs.existsSync(tasksJsonPath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(tasksJsonPath, 'utf-8');
      const cleanedContent = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      return JSON.parse(cleanedContent);
    } catch {
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

  async runTask(taskName: string, inputValues?: Record<string, string>): Promise<TaskRunResult> {
    const tasks = await vscode.tasks.fetchTasks();
    const task = tasks.find((t) => t.name === taskName);
    if (!task) {
      return { success: false, error: `Task "${taskName}" not found` };
    }
    try {
      let taskToRun = task;
      if (inputValues && Object.keys(inputValues).length > 0) {
        taskToRun = this.createTaskWithInputs(task, inputValues);
      }
      const execution = await vscode.tasks.executeTask(taskToRun);
      const executionId = this.generateExecutionId();
      this.activeExecutions.set(executionId, execution);
      const executionInfo: TaskExecutionInfo = {
        executionId,
        taskName,
        status: 'running',
        startTime: Date.now()
      };
      this.executions.set(executionId, executionInfo);
      this.outputs.set(executionId, '(Terminal output capture not available - use VS Code terminal to view output)');
      return { success: true, executionId };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  private createTaskWithInputs(originalTask: vscode.Task, inputValues: Record<string, string>): vscode.Task {
    const rawCommand = this.getRawCommand(originalTask);
    let substitutedCommand = rawCommand;
    for (const [inputId, value] of Object.entries(inputValues)) {
      const pattern = new RegExp(`\\$\\{input:${inputId}\\}`, 'g');
      substitutedCommand = substitutedCommand.replace(pattern, value);
    }
    const shellExec = new vscode.ShellExecution(substitutedCommand);
    const newTask = new vscode.Task(
      originalTask.definition,
      originalTask.scope || vscode.TaskScope.Workspace,
      originalTask.name,
      originalTask.source,
      shellExec,
      originalTask.problemMatchers
    );
    newTask.presentationOptions = originalTask.presentationOptions;
    newTask.isBackground = originalTask.isBackground;
    return newTask;
  }

  async runTaskAndWait(
    taskName: string,
    inputValues?: Record<string, string>,
    timeoutMs: number = 300000
  ): Promise<{
    success: boolean;
    executionId?: string;
    status?: TaskExecutionInfo['status'];
    exitCode?: number;
    output?: string;
    error?: string;
  }> {
    const result = await this.runTask(taskName, inputValues);
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
    return { found: true, output: output || '' };
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

  private onTaskStarted(e: vscode.TaskStartEvent) {
    console.log(`Task started: ${e.execution.task.name}`);
  }

  private onTaskEnded(e: vscode.TaskEndEvent) {
    const taskName = e.execution.task.name;
    for (const [execId, exec] of this.activeExecutions) {
      if (exec === e.execution) {
        this.activeExecutions.delete(execId);
        const info = this.executions.get(execId);
        if (info && info.status === 'running') {
          info.status = 'completed';
          info.endTime = Date.now();
        }
        break;
      }
    }
    console.log(`Task ended: ${taskName}`);
  }

  private onTaskProcessEnded(e: vscode.TaskProcessEndEvent) {
    const taskName = e.execution.task.name;
    for (const [execId, exec] of this.activeExecutions) {
      if (exec === e.execution) {
        const info = this.executions.get(execId);
        if (info) {
          info.exitCode = e.exitCode;
          if (info.status === 'running') {
            info.status = e.exitCode === 0 ? 'completed' : 'failed';
            info.endTime = Date.now();
          }
        }
        this.activeExecutions.delete(execId);
        break;
      }
    }
    console.log(`Task process ended: ${taskName} with exit code ${e.exitCode}`);
  }

  private generateExecutionId(): string {
    return `exec-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.executions.clear();
    this.outputs.clear();
    this.activeExecutions.clear();
  }
}
