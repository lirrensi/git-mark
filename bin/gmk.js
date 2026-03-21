#!/usr/bin/env -S node --experimental-strip-types
import { runCli } from '../src/cli.ts';

await runCli(process.argv.slice(2));
