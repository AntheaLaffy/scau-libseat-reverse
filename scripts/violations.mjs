#!/usr/bin/env node
// 我的违约记录
// 等价于：node cli.mjs violations $@
import { run } from '../cli.mjs';
await run('violations', process.argv.slice(2));
