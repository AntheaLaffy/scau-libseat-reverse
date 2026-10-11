#!/usr/bin/env node
// 智能规划：找满足时长的座位方案
// 等价于：node cli.mjs smart-plan $@
import { run } from '../cli.mjs';
await run('smart-plan', process.argv.slice(2));
