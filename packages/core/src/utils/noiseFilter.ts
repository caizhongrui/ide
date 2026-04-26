/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Noise Filter
 *
 *  对齐码弦 IDE 当前 `globConstants.ts`（v1.108.x）完整 229 行规格。
 *
 *  统一 list_files / glob / search_files / codebase_search 等只读工具的"噪音目录/文件"过滤策略。
 *  零平台依赖（纯字符串处理），所有形态共享。
 *
 *  策略：
 *  - 默认开启
 *  - 当用户 path 明确指向噪音目录内部时禁用（尊重显式搜索意图）
 *--------------------------------------------------------------------------------------------*/

/**
 * 需要忽略的大型目录列表
 * 用于文件列表和代码库扫描时过滤
 */
export const DIRS_TO_IGNORE: readonly string[] = [
	'node_modules',
	'bower_components',
	'__pycache__',
	'.pytest_cache',
	'.tox',
	'venv',
	'.venv',
	'target/dependency',
	'target',
	'build/dependencies',
	'build',
	'dist',
	'out',
	'coverage',
	'logs',
	'log',
	'bundle',
	'vendor',
	'tmp',
	'temp',
	'deps',
	'pkg',
	'Pods',
	'fonts',
	'font',
	'images',
	'image',
	'img',
	'public',
	'static',
	'generated',
	'.generated',
	'bin',
	'obj',
	'.yarn',
	'.pnpm-store',
	'.parcel-cache',
	'.sass-cache',
	'.cache',
	'.maxian',
	'.next',
	'.nuxt',
	'.turbo',
	'.idea',
	'.vscode',
	'.gradle',
	'.mvn',
	'.svn',
	'.hg',
	'.git',
	'.*',
];

/**
 * search_files / codebase_search / glob 的统一噪音目录过滤规则（vscode glob.IExpression 形态）
 * 默认开启；当用户明确把 path 指向噪音目录内部时，允许绕过过滤。
 *
 * 注：这里是 `Record<string, true>` 形式，方便 IDE 直接传给 vscode searchService.textSearch 的 excludePattern。
 *      sidecar/Node 形态可通过 picomatch 对每条 key 匹配。
 */
export const TOOL_SEARCH_EXCLUDE_GLOBS: Record<string, true> = {
	'**/node_modules/**':    true,
	'**/bower_components/**': true,
	'**/.git/**':            true,
	'**/.svn/**':            true,
	'**/.hg/**':             true,
	'**/.maxian/**':         true,
	'**/.cache/**':          true,
	'**/.idea/**':           true,
	'**/.vscode/**':         true,
	'**/.gradle/**':         true,
	'**/.mvn/**':            true,
	'**/target/**':          true,
	'**/build/**':           true,
	'**/dist/**':            true,
	'**/out/**':             true,
	'**/coverage/**':        true,
	'**/logs/**':            true,
	'**/log/**':             true,
	'**/tmp/**':             true,
	'**/temp/**':            true,
	'**/bin/**':             true,
	'**/obj/**':             true,
	'**/public/**':          true,
	'**/static/**':          true,
	'**/fonts/**':           true,
	'**/font/**':            true,
	'**/images/**':          true,
	'**/image/**':           true,
	'**/img/**':             true,
	'**/generated/**':       true,
	'**/.generated/**':      true,
	'**/__pycache__/**':     true,
	'**/.pytest_cache/**':   true,
	'**/.tox/**':            true,
	'**/venv/**':            true,
	'**/.venv/**':           true,
	'**/.yarn/**':           true,
	'**/.pnpm-store/**':     true,
	'**/.parcel-cache/**':   true,
	'**/.sass-cache/**':     true,
	'**/.next/**':           true,
	'**/.nuxt/**':           true,
	'**/.turbo/**':          true,
	'**/Pods/**':            true,
	'**/vendor/**':          true,
	'**/*.min.js':           true,
	'**/*.min.css':          true,
	'**/*.map':              true,
	'**/*.svg':              true,
	'**/*.png':              true,
	'**/*.jpg':              true,
	'**/*.jpeg':             true,
	'**/*.gif':              true,
	'**/*.webp':             true,
	'**/*.ico':              true,
	'**/*.woff':             true,
	'**/*.woff2':            true,
	'**/*.ttf':              true,
	'**/*.eot':              true,
	'**/*.pdf':              true,
	'**/*.jar':              true,
	'**/*.class':            true,
};

const NOISE_PATH_SEGMENTS = [
	'/node_modules/',
	'/bower_components/',
	'/.git/',
	'/.svn/',
	'/.hg/',
	'/.maxian/',
	'/.cache/',
	'/.idea/',
	'/.vscode/',
	'/.gradle/',
	'/.mvn/',
	'/target/',
	'/build/',
	'/dist/',
	'/out/',
	'/coverage/',
	'/logs/',
	'/log/',
	'/tmp/',
	'/temp/',
	'/bin/',
	'/obj/',
	'/public/',
	'/static/',
	'/fonts/',
	'/font/',
	'/images/',
	'/image/',
	'/img/',
	'/generated/',
	'/.generated/',
	'/__pycache__/',
	'/.pytest_cache/',
	'/.tox/',
	'/venv/',
	'/.venv/',
	'/.yarn/',
	'/.pnpm-store/',
	'/.parcel-cache/',
	'/.sass-cache/',
	'/.next/',
	'/.nuxt/',
	'/.turbo/',
	'/pods/',
	'/vendor/',
];

const NOISE_FILE_EXTENSIONS = [
	'.min.js',
	'.min.css',
	'.map',
	'.svg',
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.ico',
	'.woff',
	'.woff2',
	'.ttf',
	'.eot',
	'.pdf',
	'.jar',
	'.class',
];

function normalizePathLike(input: string): string {
	return `/${(input || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()}/`;
}

/**
 * 判断路径是否命中噪音目录/文件
 */
export function isLikelyNoisePath(pathLike: string): boolean {
	const normalized = normalizePathLike(pathLike);
	if (NOISE_PATH_SEGMENTS.some(segment => normalized.includes(segment))) {
		return true;
	}

	const loweredPath = (pathLike || '').replace(/\\/g, '/').toLowerCase();
	return NOISE_FILE_EXTENSIONS.some(ext => loweredPath.endsWith(ext));
}

/**
 * 是否对本次搜索启用噪音目录过滤
 * - 默认启用
 * - 当 path 明确落在噪音目录内部时禁用（尊重显式搜索意图）
 */
export function shouldApplyNoiseFiltering(searchPath: string, workspaceRoot: string): boolean {
	const normalizedSearchPath = normalizePathLike(searchPath);
	const normalizedWorkspace  = normalizePathLike(workspaceRoot);

	if (!workspaceRoot || !searchPath) {
		return true;
	}

	if (!normalizedSearchPath.startsWith(normalizedWorkspace)) {
		return true;
	}

	const relative = normalizedSearchPath.slice(normalizedWorkspace.length).replace(/^\/+|\/+$/g, '');
	if (!relative) {
		return true;
	}

	return !isLikelyNoisePath(relative);
}

/**
 * 判断目录名（单段）是否在 DIRS_TO_IGNORE 名单内
 * 用于 listDir 递归时按目录名快速过滤（不带路径上下文）
 */
export function isIgnoredDirName(name: string): boolean {
	if (!name) return false;
	return DIRS_TO_IGNORE.includes(name);
}
