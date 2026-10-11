#!/usr/bin/env node
// 签退
// 等价于：node cli.mjs signout $@
import { run } from '../cli.mjs';
await run('signout', process.argv.slice(2));
