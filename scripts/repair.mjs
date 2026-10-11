#!/usr/bin/env node
// 设备报修
// 等价于：node cli.mjs repair $@
import { run } from '../cli.mjs';
await run('repair', process.argv.slice(2));
