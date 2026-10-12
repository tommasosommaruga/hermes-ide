import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Hermes Local IDE', () => {
  test('Extension is present', () => {
    assert.ok(vscode.extensions.getExtension('hermes-ide.hermes-ide'));
  });
});
