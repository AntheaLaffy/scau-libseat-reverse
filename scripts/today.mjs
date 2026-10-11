#!/usr/bin/env node
// 今日预约
// 等价于：node cli.mjs today $@
import { run } from '../cli.mjs';
await run('today', process.argv.slice(2));
