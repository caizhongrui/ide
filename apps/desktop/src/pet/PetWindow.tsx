/*---------------------------------------------------------------------------------------------
 *  PetWindow — 桌面豹子宠物（K-Pet 阶段）
 *
 *  挂在独立的 Tauri WebviewWindow 里（透明 + always-on-top + 无边框），
 *  通过 Tauri 事件 'pet:state' 接收主窗口的 agent 状态广播，并切换 SVG 动画类。
 *
 *  四种状态（与 Codex 类似的产品语义）：
 *    - idle       —— 空闲（呼吸动画，缓慢起伏）
 *    - running    —— agent 跑工具中（轻快踱步 + 尾巴左右摆）
 *    - waiting    —— 工具审批 / question 阻塞中（歪头眨眼 + 尾巴竖起摇摆）
 *    - review     —— 任务完成等审查（兴奋跳跃 + 招手）—— 自动 5 秒后退回 idle
 *
 *  右键菜单：靠边 / 始终置顶切换 / 关闭。
 *  鼠标按住身体可拖动整个窗口（Tauri 提供 startDragging）。
 *--------------------------------------------------------------------------------------------*/

import { createSignal, onMount, onCleanup, Show, createMemo } from 'solid-js'
import type { Component } from 'solid-js'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Leopard } from './Leopard'

export type PetState = 'idle' | 'running' | 'waiting' | 'review' | 'failed'

export const PetWindow: Component = () => {
	const [state, setState] = createSignal<PetState>('idle')
	const [showMenu, setShowMenu] = createSignal(false)
	const [menuPos, setMenuPos] = createSignal({ x: 0, y: 0 })
	const [hoverHint, setHoverHint] = createSignal<string | null>(null)

	let _unlistenState: UnlistenFn | null = null
	let _reviewTimer: number | null = null

	// 自动从 review → idle 的逻辑：review 进入 5 秒后自动退回 idle，让用户切回主窗口看完后宠物恢复闲暇
	const setStateWithAutoIdle = (next: PetState) => {
		if (_reviewTimer != null) {
			clearTimeout(_reviewTimer)
			_reviewTimer = null
		}
		setState(next)
		if (next === 'review' || next === 'failed') {
			_reviewTimer = window.setTimeout(() => {
				setState('idle')
				_reviewTimer = null
			}, next === 'failed' ? 3500 : 5000)
		}
	}

	onMount(async () => {
		_unlistenState = await listen<{ state: PetState; hint?: string }>('pet:state', (event) => {
			setStateWithAutoIdle(event.payload.state)
			setHoverHint(event.payload.hint ?? null)
		})
	})

	onCleanup(() => {
		_unlistenState?.()
		if (_reviewTimer != null) clearTimeout(_reviewTimer)
	})

	// 拖动：按住身体即可移动整个窗口（用 Tauri 的 startDragging）
	const onPointerDown = async (e: PointerEvent) => {
		// 右键弹菜单，不拖动
		if (e.button === 2) {
			e.preventDefault()
			setMenuPos({ x: e.clientX, y: e.clientY })
			setShowMenu(true)
			return
		}
		try {
			await getCurrentWindow().startDragging()
		} catch (_) { /* 某些环境拖动可能失败，忽略 */ }
	}

	const onContextMenu = (e: MouseEvent) => {
		e.preventDefault()
		setMenuPos({ x: e.clientX, y: e.clientY })
		setShowMenu(true)
	}

	const closeMenu = () => setShowMenu(false)

	const hidePet = async () => {
		closeMenu()
		try { await invoke('pet_window_hide') } catch (e) { console.warn('[Pet] hide failed:', e) }
	}

	const snapTopRight = async () => {
		closeMenu()
		try { await invoke('pet_window_snap', { corner: 'top-right' }) } catch { /* ignore */ }
	}
	const snapBottomRight = async () => {
		closeMenu()
		try { await invoke('pet_window_snap', { corner: 'bottom-right' }) } catch { /* ignore */ }
	}
	const snapBottomLeft = async () => {
		closeMenu()
		try { await invoke('pet_window_snap', { corner: 'bottom-left' }) } catch { /* ignore */ }
	}

	// 状态文本（hover/tooltip 显示用）
	const statusText = createMemo(() => {
		switch (state()) {
			case 'running': return '执行中…'
			case 'waiting': return '等待你确认'
			case 'review':  return '完成了，等审查 ✓'
			case 'failed':  return '出错了 ✕'
			default:        return '空闲'
		}
	})

	return (
		<div class="pet-root" data-state={state()} onContextMenu={onContextMenu}>
			{/* 状态光晕（背景圆，颜色按状态变） */}
			<div class="pet-aura" />
			{/* 豹子主体 */}
			<div class="pet-body" onPointerDown={onPointerDown}>
				<Leopard state={state()} />
			</div>
			{/* 状态文字 — 仅在 hover 时显示（避免常驻分散注意力） */}
			<div class="pet-status">
				<span class="pet-status-text">{hoverHint() ?? statusText()}</span>
			</div>

			{/* 右键菜单 */}
			<Show when={showMenu()}>
				<div
					class="pet-ctx-menu"
					style={{ left: `${menuPos().x}px`, top: `${menuPos().y}px` }}
					onPointerLeave={closeMenu}
				>
					<button class="pet-ctx-item" onClick={() => snapTopRight()}>📌 靠右上</button>
					<button class="pet-ctx-item" onClick={() => snapBottomRight()}>📌 靠右下</button>
					<button class="pet-ctx-item" onClick={() => snapBottomLeft()}>📌 靠左下</button>
					<div class="pet-ctx-divider" />
					<button class="pet-ctx-item pet-ctx-danger" onClick={() => hidePet()}>✕ 隐藏宠物</button>
				</div>
			</Show>
		</div>
	)
}
