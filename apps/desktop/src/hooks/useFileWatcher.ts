/*---------------------------------------------------------------------------------------------
 *  useFileWatcher — 外部文件变更检测（P0-4，K11a-cont）
 *  每 N 秒轮询一组路径的 mtime，发现外部修改时触发回调
 *--------------------------------------------------------------------------------------------*/

import { onMount, onCleanup } from 'solid-js'

export interface WatchedTab {
	path:     string
	loading:  boolean
	mtimeMs?: number
	extChangedAt?: number
}

export interface FileStat {
	exists:   boolean
	mtimeMs:  number
}

export interface FileWatcherOptions<TWS> {
	/** 当前工作区 getter（返回 null 表示无活动工作区，跳过本次轮询） */
	workspace:    () => TWS | null
	/** 工作区 ID 提取器（避免 hook 依赖具体 Workspace 类型） */
	getWorkspaceId: (ws: TWS) => string
	/** 当前所有被监听的预览标签 */
	tabs:         () => WatchedTab[]
	/** 远程获取 file stat */
	getFileStat: (workspaceId: string, path: string) => Promise<FileStat>
	/** 检测到外部修改时的回调（仅传入路径，调用方自行更新 UI） */
	onExternalChange: (path: string, newMtimeMs: number) => void
	/** 轮询间隔（毫秒），默认 3000 */
	intervalMs?:  number
	/** mtime 容差（毫秒），低于此值视为相同。默认 2 */
	tolerance?:   number
}

export function useFileWatcher<TWS>(opts: FileWatcherOptions<TWS>): void {
	const intervalMs = opts.intervalMs ?? 3000
	const tolerance  = opts.tolerance  ?? 2

	onMount(() => {
		let stopped = false
		const tick = async (): Promise<void> => {
			if (stopped) return
			try {
				const ws = opts.workspace()
				const tabs = opts.tabs()
				if (ws && tabs.length > 0) {
					const wsId = opts.getWorkspaceId(ws)
					for (const tab of tabs) {
						if (tab.loading) continue
						if (tab.mtimeMs === undefined) continue
						// 已标记过的保持（用户未重载前不重复提示）
						if (tab.extChangedAt) continue
						try {
							const st = await opts.getFileStat(wsId, tab.path)
							if (st.exists && Math.abs(st.mtimeMs - tab.mtimeMs) > tolerance) {
								opts.onExternalChange(tab.path, st.mtimeMs)
							}
						} catch { /* ignore per-tab errors */ }
					}
				}
			} catch { /* ignore */ }
			if (!stopped) setTimeout(() => void tick(), intervalMs)
		}
		setTimeout(() => void tick(), intervalMs)
		onCleanup(() => { stopped = true })
	})
}
