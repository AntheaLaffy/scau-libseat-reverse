#!/usr/bin/env node
// 我的预约列表
// 等价于：node cli.mjs mine $@
import { run } from '../cli.mjs';
await run('mine', process.argv.slice(2));
