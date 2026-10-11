#!/usr/bin/env node
// 预约详情
// 等价于：node cli.mjs detail $@
import { run } from '../cli.mjs';
await run('detail', process.argv.slice(2));
