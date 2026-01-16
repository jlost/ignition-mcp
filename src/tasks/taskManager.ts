import * as vscode from 'vscode';

export interface TaskInfo {
  name: string;
  source: string;
  type: string;
  scope?: string;
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
    return tasks.map((task) => ({
      name: task.name,
      source: task.source,
      type: task.definition.type,
      scope: this.getScopeName(task.scope)
    }));
  }

  private getScopeName(scope: vscode.TaskScope | vscode.WorkspaceFolder | undefined): string | undefined {
    if (scope === vscode.TaskScope.Global) return 'global';
    if (scope === vscode.TaskScope.Workspace) return 'workspace';
    if (scope && typeof scope === 'object' && 'name' in scope) return scope.name;
    return undefined;
  }

  async runTask(taskName: string): Promise<TaskRunResult> {
    const tasks = await vscode.tasks.fetchTasks();
    const task = tasks.find((t) => t.name === taskName);
    if (!task) {
      return { success: false, error: `Task "${taskName}" not found` };
    }
    try {
      const execution = await vscode.tasks.executeTask(task);
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
