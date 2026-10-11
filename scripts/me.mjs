#!/usr/bin/env node
// 我的档案：积分 / 违约
// 等价于：node cli.mjs me $@
import { run } from '../cli.mjs';
await run('me', process.argv.slice(2));
