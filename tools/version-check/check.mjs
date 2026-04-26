#!/usr/bin/env node
/**
 * O2: 版本一致性检查
 *
 * 桌面端一份版本号必须在 4 个地方同步：
 *   1. apps/desktop/package.json#version
 *   2. apps/desktop/src-tauri/tauri.conf.json#version
 *   3. apps/desktop/src-tauri/Cargo.toml#package.version
 *   4. apps/desktop/src/App.tsx CHANGELOG[0].version  （仅警告，不强制 fail）
 *
 * 前 3 个不一致 → 退出 1，CI 失败。
 * 第 4 个不一致 → 警告（rebump 时偶尔会忘了更新 CHANGELOG）。
 *
 * 用法：node tools/version-check/check.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

function readJson(rel) {
	return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'));
}

function readText(rel) {
	return readFileSync(resolve(ROOT, rel), 'utf8');
}

const errors = [];
const warnings = [];

// 1. apps/desktop/package.json
const pkg = readJson('apps/desktop/package.json');
const pkgVer = pkg.version;
if (!pkgVer) errors.push('apps/desktop/package.json: 缺少 version 字段');

// 2. tauri.conf.json
const tauri = readJson('apps/desktop/src-tauri/tauri.conf.json');
const tauriVer = tauri.version;
if (tauriVer !== pkgVer) {
	errors.push(`tauri.conf.json#version (${tauriVer}) ≠ package.json#version (${pkgVer})`);
}

// 3. Cargo.toml
const cargo = readText('apps/desktop/src-tauri/Cargo.toml');
const cargoMatch = cargo.match(/^version\s*=\s*"([^"]+)"/m);
const cargoVer = cargoMatch?.[1];
if (cargoVer !== pkgVer) {
	errors.push(`Cargo.toml#version (${cargoVer}) ≠ package.json#version (${pkgVer})`);
}

// 4. App.tsx CHANGELOG[0]
try {
	const app = readText('apps/desktop/src/App.tsx');
	// 找 CHANGELOG 数组首条 version
	const match = app.match(/const CHANGELOG[^=]*=\s*\[\s*\{\s*version:\s*'([^']+)'/);
	const changelogVer = match?.[1];
	if (!changelogVer) {
		warnings.push('App.tsx: CHANGELOG 数组首条无法解析 version 字段');
	} else if (changelogVer !== pkgVer) {
		warnings.push(`App.tsx CHANGELOG[0].version (${changelogVer}) ≠ package.json#version (${pkgVer})（bump 时记得 unshift 一条新 entry）`);
	}
} catch (e) {
	warnings.push(`App.tsx 检查失败: ${e.message}`);
}

console.log(`[version-check] desktop 版本基线: ${pkgVer}`);

if (warnings.length > 0) {
	for (const w of warnings) console.warn(`[version-check] ⚠ ${w}`);
}

if (errors.length > 0) {
	console.error('');
	console.error('[version-check] ❌ 发现版本不一致：');
	for (const e of errors) console.error(`  - ${e}`);
	console.error('');
	console.error('修复方法：把 4 处版本字段同步到一致（推荐 `pnpm desktop:bump <new-version>` 一键改）');
	process.exit(1);
}

console.log('[version-check] ✅ 所有版本字段一致');
