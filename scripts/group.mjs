#!/usr/bin/env node
// 空间组队 / 邀请
// 等价于：node cli.mjs group $@
import { run } from '../cli.mjs';
await run('group', process.argv.slice(2));
