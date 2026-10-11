#!/usr/bin/env node
// 公告
// 等价于：node cli.mjs announcements $@
import { run } from '../cli.mjs';
await run('announcements', process.argv.slice(2));
