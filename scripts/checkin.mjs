#!/usr/bin/env node
// 签到
// 等价于：node cli.mjs checkin $@
import { run } from '../cli.mjs';
await run('checkin', process.argv.slice(2));
