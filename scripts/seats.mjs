#!/usr/bin/env node
// 某房间某时段的座位占用
// 等价于：node cli.mjs seats $@
import { run } from '../cli.mjs';
await run('seats', process.argv.slice(2));
