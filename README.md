# Tasks MCP Server

A VS Code extension that exposes VS Code tasks via MCP (Model Context Protocol), allowing AI assistants like Cursor to run your project's tasks.

## Features

- **MCP Server**: Runs an HTTP/SSE MCP server in the background
- **Task Execution**: Run any VS Code task (from tasks.json) via MCP
- **Output Capture**: Get real-time task output
- **Task Management**: List, run, cancel, and monitor task status
- **Auto-Configuration**: One-click setup for Cursor

## Installation

### From Source

1. Clone or download this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the extension:
   ```bash
   npm run build
   ```
4. Install in VS Code/Cursor:
   - Open the Extensions view
   - Click "..." menu -> "Install from VSIX..."
   - Select the generated `.vsix` file (run `npx vsce package` first)

### Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Open this folder in VS Code/Cursor

3. Press F5 to launch the Extension Development Host
   - This automatically runs the watch build task
   - A new VS Code window opens with the extension loaded

4. Make changes to the source files - they rebuild automatically

5. Press Ctrl+Shift+F5 (or Cmd+Shift+F5 on Mac) to reload the extension

## Usage

### Starting the Server

The MCP server starts automatically when VS Code opens (configurable). You can also:

1. Open Command Palette (Ctrl/Cmd + Shift + P)
2. Run "Tasks MCP: Enable Server"

### Configuring Cursor

1. Open Command Palette
2. Run "Tasks MCP: Configure Cursor"
3. This adds the server to `~/.cursor/mcp.json`

Or manually add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "vscode-tasks": {
      "url": "http://localhost:3500/sse"
    }
  }
}
```

### Available Commands

| Command | Description |
|---------|-------------|
| Tasks MCP: Enable Server | Start the MCP server |
| Tasks MCP: Disable Server | Stop the MCP server |
| Tasks MCP: Configure Cursor | Add to Cursor's mcp.json |
| Tasks MCP: Show Status | Show server status and options |

## MCP Tools

The following tools are exposed via MCP:

### list_tasks

List all available VS Code tasks from the workspace.

**Parameters**: None

**Returns**: Array of task objects with name, source, type, and scope.

### run_task

Execute a VS Code task by name.

**Parameters**:
- `taskName` (string): The name of the task to run

**Returns**: Object with success status and executionId for tracking.

### get_task_status

Get the status of a task execution.

**Parameters**:
- `executionId` (string): The execution ID from run_task

**Returns**: Object with status (running/completed/failed/cancelled), timing info, and exit code.

### get_task_output

Get the captured output from a task execution.

**Parameters**:
- `executionId` (string): The execution ID from run_task

**Returns**: Object with the captured terminal output.

### cancel_task

Cancel a running task.

**Parameters**:
- `executionId` (string): The execution ID from run_task

**Returns**: Object with success status.

## Configuration

Configure the extension in VS Code settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `tasks-mcp.port` | 3500 | Port for the MCP server |
| `tasks-mcp.autoStart` | true | Start server when VS Code opens |

## Example Workflow

1. Define tasks in `.vscode/tasks.json`:
   ```json
   {
     "version": "2.0.0",
     "tasks": [
       {
         "label": "Build",
         "type": "shell",
         "command": "npm run build"
       },
       {
         "label": "Test",
         "type": "shell",
         "command": "npm test"
       }
     ]
   }
   ```

2. Start the MCP server (auto-starts by default)

3. Configure Cursor using the command

4. Ask Cursor to run tasks:
   - "Run the Build task"
   - "List all available tasks"
   - "Run tests and show me the output"

## Status Bar

The extension shows a status indicator in the VS Code status bar:
- **MCP: Running (3500)** - Server is active on port 3500
- **MCP: Stopped** - Server is not running

Click the status bar item to access quick actions.

## Troubleshooting

### Server won't start

- Check if port 3500 is already in use
- Try changing the port in settings
- Check the Output panel for errors

### Tasks not appearing

- Make sure tasks are defined in `.vscode/tasks.json`
- Reload VS Code window
- Check that tasks are valid (no syntax errors)

### Output not captured

- Terminal output capture requires VS Code 1.85+
- Some task types may not expose output
- Long-running tasks accumulate output over time

## License

MIT
