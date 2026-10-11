#!/usr/bin/env node
// 续座
// 等价于：node cli.mjs continue $@
import { run } from '../cli.mjs';
await run('continue', process.argv.slice(2));
