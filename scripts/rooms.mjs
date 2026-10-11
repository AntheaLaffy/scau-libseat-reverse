#!/usr/bin/env node
// 房间/座位区列表
// 等价于：node cli.mjs rooms $@
import { run } from '../cli.mjs';
await run('rooms', process.argv.slice(2));
