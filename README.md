<img src="docs/ignition-mcp-logo.jpg" alt="Ignition MCP Logo" width="150" align="right" />

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/jostrand.ignition-mcp?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=jostrand.ignition-mcp)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/jostrand.ignition-mcp)](https://marketplace.visualstudio.com/items?itemName=jostrand.ignition-mcp)
[![Open VSX](https://img.shields.io/open-vsx/v/jostrand/ignition-mcp?label=Open%20VSX)](https://open-vsx.org/extension/jostrand/ignition-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Release](https://img.shields.io/github/v/release/jlost/ignition-mcp)](https://github.com/jlost/ignition-mcp/releases)
[![Power Level](https://img.shields.io/badge/power-%3E9000-ff6600)](https://www.youtube.com/watch?v=SiMHTK15Pik)

# 🔥 Ignition MCP

A VS Code extension that exposes tasks and launch configurations via MCP (Model Context Protocol), letting AI assistants run your builds, tests, and debug sessions.

**Works with:** VS Code + Copilot, Cursor, Claude Code, Claude Desktop, and any MCP-compatible client.

## ✨ Features

- 🌐 **MCP Server**: Runs an HTTP/SSE MCP server in the background
- ⚡ **Task Execution**: Run any VS Code task (from tasks.json) via MCP
- 🐛 **Debug Sessions**: Start any VS Code launch configuration (from launch.json) via MCP
- 📤 **Output Capture**: Get real-time task output
- 📋 **Task Management**: List, run, cancel, and monitor task status
- 🎯 **Debug Management**: List, start, and stop debug sessions
- 🔧 **Auto-Configuration**: Automatic setup for VS Code, Cursor, and Claude

## ⚙️ Configuration

Configure the extension in VS Code settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `ignition-mcp.port` | 3500 | Port for the MCP server |

## 🚀 Usage

### MCP Client Configuration (Project-Local)

On startup, the extension automatically configures project-local MCP settings:

1. **If `mcp.json` exists** in `.vscode/`, `.cursor/`, or as `.mcp.json` - updates all existing files
2. **If no `mcp.json` but directory exists** - creates `mcp.json` in `.vscode/` or `.cursor/`
3. **If neither exists** - creates the appropriate directory based on your IDE (`.vscode/` for VS Code, `.cursor/` for Cursor)

This means your AI assistant will automatically discover the MCP server when you open the project.

### MCP Client Configuration (Global)

For global configuration (applies to all projects), run **"Ignition MCP: Configure MCP Client"** from the Command Palette. This shows options for:

- `~/.cursor/mcp.json` (Cursor global)
- `~/.claude.json` (Claude Code global)
- Claude Desktop config (platform-specific path)
- Custom path (enter any location)

### MCP Config Example

```json
{
  "servers": {
    "ignition-mcp": {
      "url": "http://localhost:3500/sse"
    }
  }
}
```

### 🎮 Available Commands

| Command | Description |
|---------|-------------|
| Ignition MCP: Configure MCP Client | Add to global config (Cursor, Claude, custom) |
| Ignition MCP: Show Status | Show server status and options |

## 🔌 MCP Tools

Each VS Code task and launch configuration is exposed as its own tool, plus utility tools for management.

### ⚡ Dynamic Task Tools

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

### 🐛 Dynamic Launch Tools

Each launch configuration defined in your workspace becomes a tool named `launch_<sanitized_name>`. For example:
- Config "Launch Program" -> tool `launch_launch_program`
- Config "Attach to Chrome" -> tool `launch_attach_to_chrome`

**All launch tools are background** (debug sessions are long-running):
- Returns immediately with a `sessionId`
- Use `get_debug_status` to check active sessions
- Use `stop_debug_session` to stop debugging

**Launch inputs** work the same as task inputs:
- All inputs are optional parameters
- Omit any input to have VS Code prompt the user

**Pre-launch tasks** are handled automatically by VS Code when the debug session starts.

### 📋 Task Utility Tools

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

### 🎯 Launch Utility Tools

#### list_launch_configs

List all available VS Code launch configurations with their metadata.

**Parameters**: None

**Returns**: Array of config objects with name, type, request, preLaunchTask, and inputs.

#### get_debug_status

Get the status of active debug sessions.

**Parameters**: None

**Returns**: Object with array of active sessions (id, name, type, status, startTime).

#### stop_debug_session

Stop a debug session.

**Parameters**:
- `sessionId` (string, optional): The session ID to stop. If omitted, stops the active session.

**Returns**: Object with success status.

## 📖 Example Workflow

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

2. The extension auto-configures the MCP server on startup

3. Ask your AI assistant to run tasks or start debugging:
   - "Run the Build task"
   - "List all available tasks"
   - "Run tests and show me the output"
   - "Run the lint script" (the AI will use the Run Script task with scriptName="lint")
   - "Start debugging the app"
   - "Stop the debug session"

## 📊 Status Bar

The extension shows a flame icon in the VS Code status bar. Hover to see the port, click for options.

## 📦 Installation

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
4. Package the extension:
   ```bash
   npx vsce package
   ```
5. Install in VS Code/Cursor:
   - Open the Extensions view
   - Click "..." menu -> "Install from VSIX..."
   - Select the generated `.vsix` file

### 🛠️ Development

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


## 🔧 Troubleshooting

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

## 🖥️ Headless Mode

Run Ignition MCP without a VS Code GUI for use with AI agents like `cursor-agent` or `claude` CLI. This allows headless task execution and debugging using VS Code Server.

See [docs/HEADLESS_MODE.md](docs/HEADLESS_MODE.md) for complete setup instructions.

## 📄 License

MIT
