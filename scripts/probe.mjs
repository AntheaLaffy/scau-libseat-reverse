#!/usr/bin/env node
// 求解器命中率探针
// 等价于：node cli.mjs probe $@
import { run } from '../cli.mjs';
await run('probe', process.argv.slice(2));
