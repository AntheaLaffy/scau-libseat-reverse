#!/usr/bin/env node
// 取消预约
// 等价于：node cli.mjs cancel $@
import { run } from '../cli.mjs';
await run('cancel', process.argv.slice(2));
