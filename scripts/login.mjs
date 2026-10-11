#!/usr/bin/env node
// 登录（cas 免验证码）
// 等价于：node cli.mjs login $@
import { run } from '../cli.mjs';
await run('login', process.argv.slice(2));
