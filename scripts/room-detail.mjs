#!/usr/bin/env node
// 房间详情：规则 + 可预约日期 + 座位表
// 等价于：node cli.mjs room-detail $@
import { run } from '../cli.mjs';
await run('room-detail', process.argv.slice(2));
