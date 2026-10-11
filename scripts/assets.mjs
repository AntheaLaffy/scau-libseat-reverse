#!/usr/bin/env node
// 座位/房间里的设备
// 等价于：node cli.mjs assets $@
import { run } from '../cli.mjs';
await run('assets', process.argv.slice(2));
