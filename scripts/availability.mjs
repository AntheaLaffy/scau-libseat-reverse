#!/usr/bin/env node
// 全馆实时空位（免登录）
// 等价于：node cli.mjs availability $@
import { run } from '../cli.mjs';
await run('availability', process.argv.slice(2));
