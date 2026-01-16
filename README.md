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

The extension **automatically configures** `~/.cursor/mcp.json` when the server starts. On first run, you'll need to restart Cursor to pick up the new MCP server.

You can also manually configure by running "Tasks MCP: Configure Cursor" from the Command Palette, or add to `~/.cursor/mcp.json`:

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

Each VS Code task is exposed as its own tool, plus utility tools for task management.

### Dynamic Task Tools

Each task defined in your workspace becomes a tool named `task_<sanitized_name>`. For example:
- Task "Build" -> tool `task_build`
- Task "npm: test" -> tool `task_npm_test`

**Behavior based on task type:**
- **Background tasks** (`isBackground: true`): Start immediately and return an `executionId`. Check progress later with `get_task_status` or `get_task_output`.
- **Foreground tasks** (`isBackground: false`): Wait for completion and return the result with exit code and output.

**Task inputs** are automatically exposed as **optional** tool parameters:
- If the AI provides **all inputs** (or they have defaults), the task runs immediately with those values
- If **any input is missing**, VS Code prompts the user for the missing values
- This allows the AI to provide what it knows and defer to the user for the rest

### Utility Tools

#### list_tasks

List all available VS Code tasks with their metadata (name, type, source, isBackground).

**Parameters**: None

**Returns**: Array of task objects.

#### get_task_status

Get the status of a task execution.

**Parameters**:
- `executionId` (string): The execution ID from a background task

**Returns**: Object with status (running/completed/failed/cancelled), timing info, and exit code.

#### get_task_output

Get the captured output from a task execution.

**Parameters**:
- `executionId` (string): The execution ID from a task

**Returns**: Object with the captured terminal output.

#### cancel_task

Cancel a running task.

**Parameters**:
- `executionId` (string): The execution ID from a task

**Returns**: Object with success status.

## Configuration

Configure the extension in VS Code settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `tasks-mcp.port` | 3500 | Port for the MCP server |
| `tasks-mcp.autoStart` | true | Start server when VS Code opens |
| `tasks-mcp.removeConfigOnStop` | false | Remove entry from mcp.json when server stops |

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
       },
       {
         "label": "Run Script",
         "type": "shell",
         "command": "npm run ${input:scriptName}"
       }
     ],
     "inputs": [
       {
         "id": "scriptName",
         "type": "pickString",
         "description": "Which script to run?",
         "options": ["dev", "build", "test", "lint"]
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
   - "Run the lint script" (Cursor will use the Run Script task with scriptName="lint")

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
