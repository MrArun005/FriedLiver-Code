import { spawn } from 'node:child_process';

/**
 * Kills a process and everything it started. Agents and their shell commands
 * spawn children of their own, and killing only the parent would leave those
 * holding memory.
 */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    return;
  }
  // Children spawned with `detached: true` lead their own process group.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}
