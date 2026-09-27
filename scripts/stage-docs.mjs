#!/usr/bin/env node
// 把 VitePress 产物从 docs/.vitepress/dist 暂存到 .assets/docs，
// 使 Cloudflare Static Assets 能直接以 /docs/* 命中（静态资源不消耗 Worker 请求额度）。
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'docs/.vitepress/dist');
const staging = resolve(root, '.assets');
const target = resolve(staging, 'docs');

await rm(staging, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(dist, target, { recursive: true });

console.log(`staged docs -> ${target}`);
