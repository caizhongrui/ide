/*---------------------------------------------------------------------------------------------
 *  Leopard — 桌面豹子（K-Pet 码弦官方形象版）
 *
 *  使用码弦官方机械豹形象的透明动态 GIF（自带循环动画 + alpha 通道）。
 *  GIF 自身已经在动，不再需要 CSS 关键帧驱动豹子身体；CSS 只负责：
 *    - 状态切换时的滤镜调色（5 种状态各有色调/亮度差异）
 *    - 浮动状态角标（?  ✓  !  spinner）
 *    - 状态切换时的弹性过渡（缩放 + 透明度 fade）
 *    - hover 显示状态文字
 *
 *  这样可以保证：
 *    1) 形象始终保持品牌一致（码弦机械豹）
 *    2) 仍然实时反映 agent 状态（颜色、角标、缩放）
 *    3) 文件极小（460KB GIF），加载即时
 *--------------------------------------------------------------------------------------------*/

import { Show } from 'solid-js'
import type { Component } from 'solid-js'
import type { PetState } from './PetWindow'
import mascotGif from './assets/mascot-animated.gif'

export const Leopard: Component<{ state: PetState }> = (props) => {
	return (
		<div class="leo-wrap">
			{/* 主体动画 GIF（码弦官方形象，自带循环） */}
			<img class="leo-img" src={mascotGif} alt="码弦机械豹" draggable={false} />

			{/* 状态浮动角标（右上角） */}
			<Show when={props.state === 'waiting'}>
				<div class="leo-badge leo-badge-waiting" title="等待你确认">?</div>
			</Show>
			<Show when={props.state === 'review'}>
				<div class="leo-badge leo-badge-review" title="任务完成">✓</div>
			</Show>
			<Show when={props.state === 'failed'}>
				<div class="leo-badge leo-badge-failed" title="出错了">!</div>
			</Show>
			<Show when={props.state === 'running'}>
				<div class="leo-badge leo-badge-running" title="执行中">
					<span class="leo-spinner-dot" />
					<span class="leo-spinner-dot" />
					<span class="leo-spinner-dot" />
				</div>
			</Show>
		</div>
	)
}
