import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'dist-test', 'PermissionHandler.mjs');

await build({
  entryPoints: [join(root, 'src/handlers/PermissionHandler.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [{
    name: 'stub-logger',
    setup(api) {
      api.onResolve({ filter: /utils\/Logger$/ }, () => ({ path: 'stub', namespace: 'stub' }));
      api.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export const log=()=>{};',
        loader: 'js',
      }));
    },
  }],
});

const mod = await import(pathToFileURL(outFile).href + `?t=${Date.now()}`);

describe('permission UI enrichment', () => {
  it('labels Cursor-like options clearly', () => {
    const opts = mod.enrichPermissionOptions([
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for session' },
      { optionId: 'allow_always', kind: 'allow_always', name: 'Allow always' },
      { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
    ]);
    assert.equal(opts[0].label, 'Allow once');
    assert.match(opts[1].description, /session ends/i);
    assert.equal(opts[2].style, 'danger');
    assert.equal(opts[3].label, 'Reject');
  });

  it('summarizes shell command access', () => {
    const req = mod.buildPermissionUiRequest({
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
      ],
      toolCall: {
        title: 'rm -rf /tmp/x',
        kind: 'execute',
        rawInput: { command: 'rm -rf /tmp/x', description: 'Dangerous cleanup' },
        content: [{ type: 'content', content: { type: 'text', text: '$ rm -rf /tmp/x' } }],
      },
    });
    assert.match(req.accessSummary, /shell|terminal|command/i);
    assert.ok(req.details.some((d) => d.includes('rm -rf')));
    assert.equal(req.options.length, 2);
  });
});
