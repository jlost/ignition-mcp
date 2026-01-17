import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const PORT_BASE = 3500;
const PORT_RANGE = 1000; // 3500-4499

/**
 * Get the port for a workspace by hashing its resolved config directory.
 * Uses the resolved (symlink-followed) path so that workspaces sharing
 * config directories via symlinks get the same port.
 */
export function getWorkspacePort(workspacePath: string): number {
  // Try to resolve the config directory path (follows symlinks)
  const configDir = path.join(workspacePath, '.cursor');
  let hashSource = workspacePath;

  try {
    if (fs.existsSync(configDir)) {
      hashSource = fs.realpathSync(configDir);
    }
  } catch {
    // Fall back to workspace path if resolution fails
  }

  const hash = crypto.createHash('md5').update(hashSource).digest();
  const offset = hash.readUInt16BE(0) % PORT_RANGE;
  return PORT_BASE + offset;
}

export type ServerOwnership = 'ours' | 'other' | 'free';

export async function checkServerOwnership(port: number): Promise<ServerOwnership> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(1000)
    });
    const data = await res.json() as { server?: string };
    return data.server === 'ignition-mcp' ? 'ours' : 'other';
  } catch {
    return 'free';
  }
}

export async function requestShutdown(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requester: 'ignition-mcp' }),
      signal: AbortSignal.timeout(2000)
    });
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
