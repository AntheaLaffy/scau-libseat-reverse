#!/usr/bin/env node
// 暂离 / 归位
// 等价于：node cli.mjs tempout $@
import { run } from '../cli.mjs';
await run('tempout', process.argv.slice(2));
