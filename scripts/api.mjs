#!/usr/bin/env node
// 原始接口逃生舱
// 等价于：node cli.mjs api $@
import { run } from '../cli.mjs';
await run('api', process.argv.slice(2));
