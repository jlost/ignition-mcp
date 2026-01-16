import * as http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { TaskManager } from '../tasks/taskManager';

export class MCPServer {
  private server: http.Server | null = null;
  private mcpServer: McpServer;
  private transports: Map<string, SSEServerTransport> = new Map();
  private port: number;
  private taskManager: TaskManager;

  constructor(taskManager: TaskManager, port: number) {
    this.taskManager = taskManager;
    this.port = port;
    this.mcpServer = new McpServer({
      name: 'vscode-tasks',
      version: '0.1.0'
    });
    this.registerTools();
  }

  private registerTools() {
    this.mcpServer.tool(
      'list_tasks',
      'List all available VS Code tasks from the workspace',
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
      'run_task',
      'Execute a VS Code task by name',
      { taskName: z.string().describe('The name of the task to run') },
      async ({ taskName }) => {
        const result = await this.taskManager.runTask(taskName);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2)
          }]
        };
      }
    );
    this.mcpServer.tool(
      'get_task_status',
      'Get the status of a task execution',
      { executionId: z.string().describe('The execution ID returned from run_task') },
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
      { executionId: z.string().describe('The execution ID returned from run_task') },
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
      { executionId: z.string().describe('The execution ID returned from run_task') },
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
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        const url = new URL(req.url || '/', `http://localhost:${this.port}`);
        if (url.pathname === '/sse' && req.method === 'GET') {
          await this.handleSSE(req, res);
        } else if (url.pathname === '/messages' && req.method === 'POST') {
          await this.handleMessages(req, res, url);
        } else if (url.pathname === '/health' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', server: 'vscode-tasks-mcp' }));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });
      this.server.on('error', (err) => {
        reject(err);
      });
      this.server.listen(this.port, () => {
        console.log(`MCP server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  private async handleSSE(req: http.IncomingMessage, res: http.ServerResponse) {
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    this.transports.set(sessionId, transport);
    res.on('close', () => {
      this.transports.delete(sessionId);
    });
    await this.mcpServer.connect(transport);
  }

  private async handleMessages(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      res.writeHead(400);
      res.end('Missing sessionId');
      return;
    }
    const transport = this.transports.get(sessionId);
    if (!transport) {
      res.writeHead(404);
      res.end('Session not found');
      return;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    try {
      await transport.handlePostMessage(req, res, body);
    } catch (error) {
      console.error('Error handling message:', error);
      res.writeHead(500);
      res.end('Internal server error');
    }
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          this.transports.clear();
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
