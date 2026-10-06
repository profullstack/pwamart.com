/**
 * pwamart over MCP on stdio: newline-delimited JSON-RPC 2.0.
 * Reads need nothing. Publishing tools need PWAMART_API_KEY; PWAMART_URL points
 * it at another server.
 */
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { call, resolveAuth } from '@profullstack/pwamart/client';
import { handleRpc } from './core.js';

const VERSION = createRequire(import.meta.url)('../package.json').version;

export function serve(input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input });
  const write = (msg) => output.write(`${JSON.stringify(msg)}\n`);
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    if (req.id === undefined || req.id === null) return; // notifications get no reply
    try {
      const auth = await resolveAuth();
      const result = await handleRpc(req, { call: (path, init) => call(auth, path, init), siteUrl: auth.server, version: VERSION });
      write({ jsonrpc: '2.0', id: req.id, result });
    } catch (err) {
      write({ jsonrpc: '2.0', id: req.id, error: { code: err.code ?? -32603, message: String(err.message) } });
    }
  });
  return rl;
}
