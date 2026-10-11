#!/usr/bin/env node
// 提交预约（座位/空间）
// 等价于：node cli.mjs reserve $@
import { run } from '../cli.mjs';
await run('reserve', process.argv.slice(2));
