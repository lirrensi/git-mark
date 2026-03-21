#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const entry = path.join(__dirname, "..", "src", "cli.ts");
const tsxCli = require.resolve("tsx/cli");
const result = spawnSync(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 0);
