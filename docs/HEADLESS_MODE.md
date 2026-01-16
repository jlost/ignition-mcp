# Headless Mode with VS Code Server

Run Ignition MCP without a VS Code GUI, allowing AI agents like `cursor-agent` or `claude` CLI to execute tasks and launch configurations headlessly.

**Quick start:**

```bash
# Start VS Code Server with tunnel
code tunnel --accept-server-license-terms serve-web --folder /path/to/workspace

# Connect once via browser to activate the extension
# Then configure your agent to use http://localhost:3500/sse
```


## Overview

In headless mode, VS Code Server runs as a background service with the Ignition MCP extension active. AI agents connect to the MCP server on port 3500 to execute the same `tasks.json` and `launch.json` configurations that humans use in VS Code/Cursor.

```
┌─────────────────────┐     HTTP/SSE       ┌──────────────────────────────┐
│   cursor-agent /    │ ─────────────────> │      VS Code Server          │
│   claude CLI        │     port 3500      │  ┌────────────────────────┐  │
│   (MCP Client)      │ <───────────────── │  │   ignition-mcp ext     │  │
└─────────────────────┘                    │  └───────────┬────────────┘  │
                                           │              │               │
                                           │      vscode.tasks.*          │
                                           │      vscode.debug.*          │
                                           └──────────────────────────────┘
```

## Prerequisites

- VS Code CLI (`code`) installed and in PATH
- The Ignition MCP extension installed
- A workspace with `.vscode/tasks.json` and/or `.vscode/launch.json`

## Setup Methods

### Method 1: VS Code Tunnel (Recommended)

VS Code Tunnel creates a persistent connection that keeps the server running.

#### One-time setup

```bash
# Authenticate with GitHub (required once)
code tunnel user login --provider github
```

#### Start the tunnel service

```bash
# Start tunnel for a specific workspace
code tunnel --accept-server-license-terms \
  --name my-dev-machine \
  serve-web \
  --folder /path/to/your/workspace
```

Or run as a background service:

```bash
# Using systemd (Linux)
code tunnel service install

# Start the service
systemctl --user start code-tunnel

# Enable on boot
systemctl --user enable code-tunnel
```

#### Activate the extension

The extension activates on `onStartupFinished`, but VS Code Server needs at least one client connection to trigger this. Options:

1. **Connect briefly via browser** - Open the tunnel URL once, then disconnect
2. **Use the VS Code desktop client** - Connect via Remote Tunnels, then close
3. **Keep a minimal connection** - See "Keeping the Server Alive" below

Once activated, the MCP server starts on port 3500 and remains available.

### Method 2: Remote SSH with Port Forwarding

If you have SSH access to your development machine:

```bash
# On your local machine, forward port 3500
ssh -L 3500:localhost:3500 user@dev-machine

# On the dev machine, start VS Code Server
code tunnel serve-web --folder /path/to/workspace
```

### Method 3: Docker Container

Run VS Code Server in a container with the extension pre-installed:

```dockerfile
FROM codercom/code-server:latest

# Install the extension
RUN code-server --install-extension ignition-mcp.vsix

# Expose MCP port
EXPOSE 3500

# Start with workspace
CMD ["--bind-addr", "0.0.0.0:8080", "/workspace"]
```

```bash
docker run -d \
  -p 8080:8080 \
  -p 3500:3500 \
  -v /path/to/workspace:/workspace \
  my-ignition-mcp-server
```

## Keeping the Server Alive

VS Code Server may shut down if no clients are connected. Solutions:

### Option A: Systemd Service (Linux)

```ini
# ~/.config/systemd/user/ignition-mcp.service
[Unit]
Description=VS Code Server with Ignition MCP
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/code tunnel --accept-server-license-terms serve-web --folder /path/to/workspace
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ignition-mcp
```

### Option B: Health Check Script

Create a script that pings the MCP server and restarts if needed:

```bash
#!/bin/bash
# check-ignition-mcp.sh

MCP_PORT=3500

if ! curl -s "http://localhost:$MCP_PORT/health" > /dev/null; then
  echo "MCP server not responding, triggering reconnection..."
  # Trigger extension activation by opening a file
  code --folder-uri "vscode-remote://tunnel+my-dev-machine/path/to/workspace" &
  sleep 5
  kill $!
fi
```

Add to crontab:
```bash
*/5 * * * * /path/to/check-ignition-mcp.sh
```

### Option C: Keep-Alive Client

Run a minimal client that maintains the connection:

```javascript
// keep-alive.js
const http = require('http');

setInterval(() => {
  http.get('http://localhost:3500/health', (res) => {
    console.log(`[${new Date().toISOString()}] Health check: ${res.statusCode}`);
  }).on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Health check failed:`, err.message);
  });
}, 30000);

console.log('Keep-alive started, checking every 30s...');
```

```bash
node keep-alive.js &
```

## Configuring AI Agents

### cursor-agent / Cursor CLI

Add to your MCP configuration (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "ignition-mcp": {
      "url": "http://localhost:3500/sse"
    }
  }
}
```

For remote servers, use the tunnel or SSH forwarded port:

```json
{
  "mcpServers": {
    "ignition-mcp": {
      "url": "http://dev-machine.local:3500/sse"
    }
  }
}
```

### Claude CLI / Other MCP Clients

Configure the SSE endpoint in your client's MCP settings:

```bash
# Example: claude CLI
export MCP_SERVERS='{"ignition-mcp": {"url": "http://localhost:3500/sse"}}'
```

## Verifying the Setup

### Check server health

```bash
curl http://localhost:3500/health
# Expected: {"status":"ok","server":"ignition-mcp"}
```

### List available tasks

Connect an MCP client and call `list_tasks`:

```bash
# Using a simple MCP test client
curl -N http://localhost:3500/sse &
SSE_PID=$!

# Send a tool call (requires MCP client library)
# The list_tasks tool will return all available tasks from tasks.json
```

### Test task execution

```bash
# Via MCP: call task_<taskname> tool
# Example: if you have a task named "build", call task_build
```

## Troubleshooting

### Extension not activating

1. Check that the extension is installed:
   ```bash
   code --list-extensions | grep ignition-mcp
   ```

2. Check VS Code Server logs:
   ```bash
   # Logs are typically in ~/.vscode-server/data/logs/
   tail -f ~/.vscode-server/data/logs/*/exthost*/exthost.log
   ```

3. Verify port 3500 is listening:
   ```bash
   ss -tlnp | grep 3500
   # or
   netstat -tlnp | grep 3500
   ```

### Port already in use

Change the port in VS Code settings:

```json
{
  "ignition-mcp.port": 3501
}
```

Or via environment:
```bash
code tunnel serve-web --folder /workspace \
  --server-data-dir /path/to/settings
```

### Connection refused from remote

Ensure the MCP server binds to all interfaces, or use SSH tunneling:

```bash
# SSH tunnel from your local machine
ssh -L 3500:localhost:3500 user@remote-dev-machine
```

### Tasks not found

1. Verify `.vscode/tasks.json` exists in the workspace
2. Check the file is valid JSON (no trailing commas, etc.)
3. Restart the extension by reconnecting to VS Code Server

## Security Considerations

- **Network exposure**: The MCP server accepts connections on port 3500. Use firewalls or SSH tunneling for remote access.
- **Task execution**: Tasks can run arbitrary shell commands. Ensure only trusted agents have access.
- **Debug sessions**: Debug adapters may expose sensitive data. Restrict access appropriately.

## Limitations

- **Output capture**: Terminal output capture is limited in headless mode. Tasks report completion status but detailed output may require checking VS Code Server logs.
- **Interactive inputs**: If a task requires `${input:...}` variables, provide them via MCP tool parameters. If not provided, the task may hang waiting for input.
- **GUI-dependent tasks**: Some tasks that open UI elements (browsers, dialogs) may fail in headless mode.

## Example Workflow

1. Start VS Code Server with tunnel:
   ```bash
   code tunnel --accept-server-license-terms serve-web --folder ~/my-project
   ```

2. Connect once to activate extension (browser or VS Code client)

3. Configure your AI agent to use `http://localhost:3500/sse`

4. Agent can now:
   - List tasks: `list_tasks`
   - Run a build: `task_build` (if you have a "build" task)
   - Start debugging: `launch_debug_my_app` (if you have a "Debug My App" launch config)
   - Check status: `get_task_status`, `get_debug_status`
