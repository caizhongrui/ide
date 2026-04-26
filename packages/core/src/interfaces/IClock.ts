/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Clock Abstraction
 *
 *  可注入的时钟抽象，方便测试 / 回放场景模拟时间。
 *  生产环境用 SystemClock，测试用 FakeClock。
 *--------------------------------------------------------------------------------------------*/

export interface IClock {
	/** 当前时间戳（毫秒） */
	now(): number;

	/** 等待若干毫秒（Promise 形式） */
	sleep(ms: number): Promise<void>;

	/** 设置定时器；返回的函数用于取消 */
	setTimeout(fn: () => void, ms: number): () => void;
}

/** 系统默认时钟实现 */
export class SystemClock implements IClock {
	now(): number {
		return Date.now();
	}
	sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
	setTimeout(fn: () => void, ms: number): () => void {
		const handle = setTimeout(fn, ms);
		return () => clearTimeout(handle);
	}
}
