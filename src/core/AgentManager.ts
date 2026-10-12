import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { log, logError } from '../utils/Logger';
import type { AgentConfigEntry } from '../config/AgentConfig';

export interface AgentInstance {
  id: string;
  name: string;
  process: ChildProcess;
  config: AgentConfigEntry;
}

export function resolveExecutable(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error('Agent command is empty');
  }
  if (isAbsolute(trimmed)) {
    accessSync(trimmed, fsConstants.X_OK);
    return trimmed;
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    const abs = resolve(trimmed);
    accessSync(abs, fsConstants.X_OK);
    return abs;
  }
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where.exe', [trimmed], { encoding: 'utf8' }).trim();
      const first = out.split(/\r?\n/).find(Boolean);
      if (!first) {
        throw new Error(`Executable not found on PATH: ${trimmed}`);
      }
      return first;
    }
    const out = execFileSync('which', [trimmed], { encoding: 'utf8' }).trim();
    if (!out) {
      throw new Error(`Executable not found on PATH: ${trimmed}`);
    }
    return out;
  } catch (e) {
    throw new Error(
      `Cannot resolve executable "${trimmed}". Install Hermes and ensure it is on PATH, ` +
        `or set acp.agents to an absolute path. ${(e as Error).message}`,
    );
  }
}

export class AgentManager extends EventEmitter {
  private agents: Map<string, AgentInstance> = new Map();
  private nextId = 1;

  spawnAgent(name: string, config: AgentConfigEntry, cwd?: string): AgentInstance {
    const id = `agent_${this.nextId++}`;
    const args = config.args || [];
    const executable = resolveExecutable(config.command);
    log(`Spawning agent "${name}" (${id}): ${executable} ${args.join(' ')} (shell=false)`);

    const joined = `${config.command} ${args.join(' ')}`.toLowerCase();
    if (joined.includes('npx') || joined.includes('@latest')) {
      throw new Error(
        'Remote/npx agent launchers are disabled in Hermes Local IDE. ' +
          'Configure a local Hermes executable (command: hermes, args: ["acp"]).',
      );
    }

    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(config.env || {}) },
      cwd: cwd || undefined,
      shell: false,
    });

    const instance: AgentInstance = { id, name, process: child, config };
    this.agents.set(id, instance);

    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        const truncated = line.length > 2000 ? `${line.slice(0, 2000)}…` : line;
        log(`[${name} stderr] ${truncated}`);
        this.emit('agent-stderr', { agentId: id, line: truncated });
      }
    });

    child.on('error', (err) => {
      logError(`Agent "${name}" process error`, err);
      this.emit('agent-error', { agentId: id, error: err });
    });

    child.on('close', (code, signal) => {
      log(`Agent "${name}" exited (code=${code}, signal=${signal})`);
      this.agents.delete(id);
      this.emit('agent-closed', { agentId: id, code, signal });
    });

    return instance;
  }

  killAgent(agentId: string): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      return false;
    }
    log(`Killing agent "${instance.name}" (${agentId})`);
    try {
      instance.process.kill('SIGTERM');
      setTimeout(() => {
        if (instance.process.exitCode === null) {
          instance.process.kill('SIGKILL');
        }
      }, 5000);
    } catch (e) {
      logError(`Failed to kill agent ${agentId}`, e);
    }
    this.agents.delete(agentId);
    return true;
  }

  getAgent(agentId: string): AgentInstance | undefined {
    return this.agents.get(agentId);
  }

  getRunningAgents(): AgentInstance[] {
    return Array.from(this.agents.values());
  }

  killAll(): void {
    for (const [id] of this.agents) {
      this.killAgent(id);
    }
  }

  dispose(): void {
    this.killAll();
    this.removeAllListeners();
  }
}
