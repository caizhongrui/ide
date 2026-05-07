/*---------------------------------------------------------------------------------------------
 *  PetEntry — pet.html 的 Solid 入口
 *
 *  独立 Tauri WebviewWindow 加载 /pet.html → 这个 entry 文件 mount Solid 组件树。
 *--------------------------------------------------------------------------------------------*/

import { render } from 'solid-js/web'
import { PetWindow } from './PetWindow'
import './pet.css'

const root = document.getElementById('pet-root')
if (root) {
	render(() => <PetWindow />, root)
} else {
	console.error('[PetEntry] #pet-root not found')
}
