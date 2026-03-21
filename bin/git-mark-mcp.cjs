#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const entry = path.join(__dirname, "..", "src", "mcp.ts");
const result = spawnSync(process.execPath, ["--import", "tsx", entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 0);
