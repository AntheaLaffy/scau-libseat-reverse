#!/usr/bin/env node
// 常见问题
// 等价于：node cli.mjs faq $@
import { run } from '../cli.mjs';
await run('faq', process.argv.slice(2));
