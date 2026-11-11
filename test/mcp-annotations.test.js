import { describe, expect, test } from 'bun:test';
import { handleRpc } from '../packages/mcp/src/core.js';

// Claude + ChatGPT directory rules: a human title and explicit hint booleans on every tool.
describe('mcp tool annotations', () => {
  test('every tool in tools/list has a title and readOnly/destructive/openWorld hints', async () => {
    const res = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { call: async () => ({}), siteUrl: 'https://pwamart.com', version: '0' });
    const tools = (res.result ?? res).tools;
    expect(tools.length).toBeGreaterThan(20);
    for (const t of tools) {
      expect(typeof t.title === 'string' && t.title.length > 0).toBe(true);
      for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
        expect(typeof t.annotations?.[hint]).toBe('boolean');
      }
      if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint).toBe(false);
    }
  });
});
