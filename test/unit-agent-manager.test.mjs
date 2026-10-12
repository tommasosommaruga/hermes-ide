import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'dist-test', 'AgentManager.mjs');

before(async () => {
  mkdirSync(join(root, 'dist-test'), { recursive: true });
  await build({
    entryPoints: [join(root, 'src/core/AgentManager.ts')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [{
      name: 'stub-logger',
      setup(api) {
        api.onResolve({ filter: /utils\/Logger$/ }, () => ({ path: 'stub', namespace: 'stub' }));
        api.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const log=()=>{}; export const logError=()=>{};',
          loader: 'js',
        }));
      },
    }],
  });
});

describe('AgentManager', () => {
  it('resolves hermes', async () => {
    const m = await import(pathToFileURL(outFile).href + `?t=${Date.now()}`);
    assert.match(m.resolveExecutable('hermes'), /hermes/);
  });

  it('rejects npx', async () => {
    const m = await import(pathToFileURL(outFile).href + `?t=${Date.now()}`);
    const mgr = new m.AgentManager();
    assert.throws(() => mgr.spawnAgent('x', { command: 'npx', args: ['@a/b@latest'] }), /npx/);
  });

  it('spawns hermes acp', async () => {
    const m = await import(pathToFileURL(outFile).href + `?t=${Date.now()}`);
    const mgr = new m.AgentManager();
    const inst = mgr.spawnAgent('Hermes Agent', { command: 'hermes', args: ['acp'] });
    assert.ok(inst.process);
    await new Promise((r) => setTimeout(r, 200));
    mgr.killAgent(inst.id);
  });
});
