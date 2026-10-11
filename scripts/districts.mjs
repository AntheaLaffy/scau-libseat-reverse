#!/usr/bin/env node
// 校区 / 区域列表
// 等价于：node cli.mjs districts $@
import { run } from '../cli.mjs';
await run('districts', process.argv.slice(2));
