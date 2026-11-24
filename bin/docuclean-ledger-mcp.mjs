#!/usr/bin/env node
import { main } from '../src/main.mjs';

const rawArgs = process.argv.slice(2);
const hasModeFlag = rawArgs.some((a) =>
  ['--stdio', '--http', '--standby', '--batch', '--input-file'].includes(a),
);
const effectiveArgs = hasModeFlag ? rawArgs : ['--stdio', ...rawArgs];

main(effectiveArgs).catch((err) => {
  console.error('[docuclean-ledger-mcp] Fatal error:', err?.stack || err);
  process.exit(1);
});
