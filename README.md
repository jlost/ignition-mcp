<img src="docs/ignition-mcp-logo-flipped.jpg" alt="Ignition MCP Logo" width="150" align="right" />

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/jostrand.ignition-mcp?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=jostrand.ignition-mcp)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/jostrand.ignition-mcp)](https://marketplace.visualstudio.com/items?itemName=jostrand.ignition-mcp)
[![Open VSX](https://img.shields.io/open-vsx/v/jostrand/ignition-mcp?label=Open%20VSX)](https://open-vsx.org/extension/jostrand/ignition-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Release](https://img.shields.io/github/v/release/jlost/ignition-mcp)](https://github.com/jlost/ignition-mcp/releases)
[![Power Level](https://img.shields.io/badge/power-%3E9000-ff6600)](https://www.youtube.com/watch?v=SiMHTK15Pik)

# 🔥 Ignition MCP

A VS Code extension that exposes tasks and launch configurations via MCP (Model Context Protocol), letting AI assistants run your builds, tests, and debug sessions.

**Works with:** VS Code + Copilot, Cursor, Claude Code, Claude Desktop, and any MCP-compatible client.

### 💡 Why Not Just Use Terminal Commands?

AI agents typically run `npm run build` in a shell. But your `tasks.json` and `launch.json` define more than commands - they include problem matchers, task dependencies, environment setup, input variables, and debug configurations.

With Ignition MCP, your AI uses VS Code's task API directly: errors populate the Problems panel, `dependsOn` chains run automatically, input variables can be provided by AI or prompt the user, and debug sessions attach properly with breakpoints.

## ✨ Features

- 🌐 **MCP Server**: Runs an HTTP/SSE MCP server in the background
- ⚡ **Task Execution**: Run any VS Code task (from tasks.json) via MCP
- 🐛 **Debug Sessions**: Start any VS Code launch configuration (from launch.json) via MCP
- 🔴 **Breakpoint Management**: Add, remove, and list breakpoints programmatically
- 🔍 **Variable Inspection**: Get variables and evaluate expressions when paused
- 📤 **Output Capture**: Get real-time task and debug console output
- 📋 **Task Management**: List, run, cancel, and monitor task status
- 🎯 **Debug Management**: List, start, stop, and control debug sessions
- 🔧 **Auto-Configuration**: Automatic setup for VS Code, Cursor, and Claude

## 🚀 Usage Example

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

2. The extension auto-configures the MCP server on startup with e.g.: 
```json
{
  "mcpServers": {
    "ignition-mcp": {
      "url": "http://localhost:<dynamic-port>/mcp"
    }
  }
}
```

3. Ask your AI assistant to run tasks or start debugging:
   - "Run the Build task"
   - "List all available tasks"
   - "Run tests and show me the output"
   - "Run the lint script" (the AI will use the Run Script task with scriptName="lint")
   - "Start debugging the app"
   - "Set a breakpoint at line 42 in main.ts"
   - "What are the current variable values?"
   - "Evaluate `user.permissions` in the current context"
   - "Continue execution"

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

### ⚙️ MCP Options

Tasks and launch configurations support an optional `mcp` block for MCP-specific settings:

```json
{
  "label": "Build",
  "type": "shell",
  "command": "npm run build",
  "mcp": {
    "returnOutput": "onFailure"
  }
}
```

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `returnOutput` | `always` / `onFailure` / `never` | `onFailure` | Controls when task output is included in MCP tool responses |

**`returnOutput` behavior:**
- `always` - Always include full terminal output in the response
- `onFailure` - Only include output when the task fails (exit code != 0)
- `never` - Never include output (use `get_task_output` to retrieve it separately)

This helps manage context size when working with AI assistants - successful builds don't need to send hundreds of lines of output, but failed builds should include the error details.

The same `mcp` block works in launch configurations in `launch.json`.

### 📋 Task Utility Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_tasks` | List all available VS Code tasks with metadata | None |
| `get_task_status` | Get status of a task execution (running/completed/failed/cancelled) | `executionId` |
| `get_task_output` | Get captured terminal output from a task | `executionId` |
| `cancel_task` | Cancel a running task | `executionId` |

### 🎯 Debug Utility Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_launch_configs` | List all available launch configurations with metadata | None |
| `get_debug_status` | Get status of active debug sessions (running/paused/terminated) | None |
| `get_debug_output` | Get captured debug console output | `sessionId` (optional) |
| `get_stack_trace` | Get the call stack from a paused session | `sessionId` (optional) |
| `stop_debug_session` | Stop a debug session | `sessionId` (optional) |

### 🔴 Breakpoint Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `add_breakpoint` | Set a breakpoint (visible in VS Code gutter) | `file`, `line`, `condition` (optional) |
| `remove_breakpoint` | Remove a breakpoint | `file`, `line` |
| `list_breakpoints` | List all current breakpoints | None |

### 🔍 Inspection Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_variables` | Get variables from current scope when paused | `sessionId` (optional), `frameId` (optional) |
| `evaluate` | Evaluate an expression in debug context | `expression`, `sessionId` (optional), `frameId` (optional) |
| `continue_execution` | Resume a paused debug session | `sessionId` (optional), `threadId` (optional) |

## 🎮 Available Commands

| Command | Description |
|---------|-------------|
| Ignition MCP: Configure MCP Client | Add to global config (Cursor, Claude, custom) |
| Ignition MCP: Show Status | Show server status and options |
| Ignition MCP: Take Over Server | Take over MCP server from another window running the same workspace |

## 📊 Status Bar

The extension shows a flame icon in the VS Code status bar. Hover to see the port, click for options.

## 🛠️ Development

### Install From Source

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

### Extension Development Host

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

### Status bar shows "Served by another window"

Another VS Code window with the same workspace is already running the MCP server. Use "Take Over Server" from the status bar menu if you want this window to handle MCP requests.

### Tasks not appearing

- Ensure tasks are defined in `.vscode/tasks.json`
- Reload the VS Code window
- Check that task definitions have no syntax errors

## 📄 License

MIT
