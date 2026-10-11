#!/usr/bin/env node
// 可预约时间片
// 等价于：node cli.mjs timespans $@
import { run } from '../cli.mjs';
await run('timespans', process.argv.slice(2));
