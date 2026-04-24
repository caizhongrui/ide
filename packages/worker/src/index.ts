/*---------------------------------------------------------------------------------------------
 *  @maxian/worker — 云端任务执行 Worker
 *
 *  用途：从任务队列（BullMQ / Redis）拉取 cloud_task，在沙箱中执行 agent。
 *  详见：docs/architecture/cloud-design.md
 *--------------------------------------------------------------------------------------------*/

export const PACKAGE_NAME = '@maxian/worker';
