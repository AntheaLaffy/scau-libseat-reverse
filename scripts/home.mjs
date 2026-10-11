#!/usr/bin/env node
// 首页概览
// 等价于：node cli.mjs home $@
import { run } from '../cli.mjs';
await run('home', process.argv.slice(2));
