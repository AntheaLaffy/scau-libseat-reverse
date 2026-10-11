#!/usr/bin/env node
// 登录状态与配置
// 等价于：node cli.mjs status $@
import { run } from '../cli.mjs';
await run('status', process.argv.slice(2));
