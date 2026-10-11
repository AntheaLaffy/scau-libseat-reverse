#!/usr/bin/env node
// 假期 / 闭馆安排
// 等价于：node cli.mjs holidays $@
import { run } from '../cli.mjs';
await run('holidays', process.argv.slice(2));
