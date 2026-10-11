#!/usr/bin/env node
// 按规划批量下单
// 等价于：node cli.mjs smart-due $@
import { run } from '../cli.mjs';
await run('smart-due', process.argv.slice(2));
