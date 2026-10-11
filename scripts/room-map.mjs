#!/usr/bin/env node
// 房间平面图（座位分布）
// 等价于：node cli.mjs room-map $@
import { run } from '../cli.mjs';
await run('room-map', process.argv.slice(2));
