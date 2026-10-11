#!/usr/bin/env node
// 抓验证码样本
// 等价于：node cli.mjs captcha $@
import { run } from '../cli.mjs';
await run('captcha', process.argv.slice(2));
