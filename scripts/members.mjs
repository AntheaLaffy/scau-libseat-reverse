#!/usr/bin/env node
// 同行成员管理
// 等价于：node cli.mjs members $@
import { run } from '../cli.mjs';
await run('members', process.argv.slice(2));
