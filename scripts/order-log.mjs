#!/usr/bin/env node
// 预约状态流水
// 等价于：node cli.mjs order-log $@
import { run } from '../cli.mjs';
await run('order-log', process.argv.slice(2));
