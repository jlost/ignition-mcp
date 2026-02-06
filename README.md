<img src="docs/ignition-mcp-logo-flipped.jpg" alt="Ignition MCP Logo" width="150" align="right" />

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/jostrand.ignition-mcp?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=jostrand.ignition-mcp)
[![Open VSX](https://img.shields.io/open-vsx/v/jostrand/ignition-mcp?label=Open%20VSX)](https://open-vsx.org/extension/jostrand/ignition-mcp)
[![Power Level](https://img.shields.io/badge/power-%3E9000-ff6600)](https://www.youtube.com/watch?v=SiMHTK15Pik)

# 🔥 Ignition MCP

**Declaratively build MCP tools and commit them to your repository.**

Define tools in `tasks.json` and `launch.json`. Your AI assistant gets access to builds, tests, deployments, debug sessions - anything you can wrap in a script. Version-controlled, shared with your team, no MCP server code required.

**Works with:** Cursor, VS Code + Copilot, Claude Code, Claude Desktop, and any MCP-compatible client.

## 💡 Why not terminal commands?

AI agents typically run `npm run build` in a shell. But VS Code tasks offer more:

| Terminal | Ignition MCP |
|----------|--------------|
| Raw output text | Errors populate the Problems panel via problem matchers |
| One command at a time | `dependsOn` chains run automatically |
| AI must know all args | Input variables prompt the user or accept AI values |
| No debug support | Full debug sessions with breakpoints and variable inspection |

Your `tasks.json` already defines how your project builds and runs. Ignition MCP exposes it to your AI.

## 🚀 Quick Start

1. **Define a task** in `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Deploy Staging",
      "type": "shell",
      "command": "python scripts/deploy.py --env ${input:environment}",
      "detail": "Deploy to staging or production with zero-downtime rollout"
    }
  ],
  "inputs": [
    {
      "id": "environment",
      "type": "pickString",
      "options": ["staging", "production"]
    }
  ]
}
```

2. **The extension auto-configures** your MCP client on startup.

3. **Ask your AI:**
   - "Deploy to staging"
   - "Run the build and show me any errors"
   - "Start debugging and set a breakpoint at line 42"
   - "What's the value of `user.permissions`?"

The task becomes an MCP tool called `task_deploy_staging`. The AI can provide the environment input, or omit it to prompt you.

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

Tasks support MCP options inside the `options` block. Launch configurations use them at the top level (you'll see a schema warning, but it works correctly). Hover over options in your editor for full documentation.

**Task example:**
```json
{
  "label": "Build",
  "type": "shell",
  "command": "npm run build",
  "options": {
    "mcp": { "returnOutput": "onFailure", "interactive": true }
  }
}
```

**Launch example:**
```json
{
  "name": "Debug",
  "type": "node",
  "request": "launch",
  "mcp": { "preserveConsole": true }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `returnOutput` | `onFailure` | When to include output: `always`, `onFailure`, `never` |
| `outputLimit` | `20480` | Max characters to capture (null = unlimited) |
| `interactive` | `false` | (Task) Run in native terminal for sudo/interactive input |
| `preserveConsole` | `false` | (Launch) Keep original console setting |

### ⏱️ Extension Settings

Configure in VS Code settings (`ignition-mcp.*`):

| Setting | Default | Description |
|---------|---------|-------------|
| `outputLimit` | `20480` | Default max characters for output capture (overridable per-task/launch) |
| `awaitTimeout` | `300000` | Default timeout in ms for `await_task` and `await_debug_event` (5 minutes) |

### 📋 Task Utility Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_tasks` | List all available VS Code tasks with metadata | None |
| `get_task_status` | Get status of a task execution (running/completed/failed/cancelled) | `executionId` |
| `get_task_output` | Get captured terminal output from a task | `executionId` |
| `cancel_task` | Cancel a running task | `executionId` |
| `await_task` | Wait for a task to complete (or timeout) | `executionId`, `timeoutMs` (optional) |

### 🎯 Debug Utility Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_launch_configs` | List all available launch configurations with metadata | None |
| `get_debug_status` | Get status of active debug sessions (running/paused/terminated) | None |
| `get_debug_output` | Get captured debug console output | `sessionId` (optional) |
| `get_stack_trace` | Get the call stack from a paused session | `sessionId` (optional) |
| `stop_debug_session` | Stop a debug session | `sessionId` (optional) |
| `await_debug_event` | Wait for state change (breakpoint, exception, termination) | `sessionId` (optional), `timeoutMs` (optional) |

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
- Check that task definitions have no syntax errors
- Run **Ignition MCP: Restart Server** from the Command Palette to refresh the tool list
- In Cursor: Open **Cursor Settings > MCP** and verify the server is enabled (toggle it off/on to reconnect)
- In VS Code: Check equivalent MCP settings in your Copilot or MCP client configuration
- Check the status bar icon - click it to see server status and options
- Reload the VS Code window as a last resort

## ⚠️ Known Limitations

### Task Execution Options

To capture task output, Ignition MCP runs tasks using its own process spawning rather than VS Code's native task execution. This means:

- **Supported options**: `cwd`, `env`, `shell.executable`, `shell.args` are respected
- **Not supported**: Other `ShellExecutionOptions` (like `shellQuoting`) may be ignored
- **Future VS Code options**: New task options added by VS Code won't be automatically supported

**Workaround**: For tasks that need full VS Code execution compatibility, use `"mcp": { "interactive": true }` in the task options. This runs the task in VS Code's native terminal (though output won't be captured).

### Launch Configuration Inputs

When a launch configuration has a `preLaunchTask` that uses input variables (`${input:...}`):

- **Simple tasks**: Inputs are substituted and the task runs without prompting
- **Background tasks** (`isBackground: true`): VS Code handles execution - user may be prompted for inputs
- **Tasks with dependencies** (`dependsOn`): VS Code handles execution - user may be prompted for inputs

This is because background tasks and task dependencies require VS Code's native task orchestration.

### Go Debug Output Capture

The Go debug adapter (Delve) writes test output directly to stdout/stderr rather than routing it through the Debug Adapter Protocol. When Ignition MCP overrides `console: "integratedTerminal"` to `"internalConsole"` for output capture, this output is lost because there's no terminal to receive it.

**Symptoms**: Debug session runs successfully but no output appears in the debug console or in `get_debug_output` results, even though running the same configuration manually shows output.

**Workaround**: Disable the console override for Go launch configurations:

```json
{
  "name": "Run Tests",
  "type": "go",
  "request": "launch",
  "mode": "test",
  "program": "${workspaceFolder}/...",
  "console": "integratedTerminal",
  "mcp": {
    "preserveConsole": true
  }
}
```

With `preserveConsole: true`, the terminal is created and output is visible, but Ignition MCP cannot capture it programmatically.

## 📄 License

MIT
