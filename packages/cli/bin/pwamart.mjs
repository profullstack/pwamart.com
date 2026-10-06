#!/usr/bin/env node
import { main } from '../src/cli.js';

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    process.stderr.write(`pwamart: ${err?.message ?? err}\n`);
    process.exit(1);
  },
);
