"use client";

// 「关注应用 / 睡眠锁」配置 → 原生。
//
// 为什么要把这份配置同步到原生：网页侧的 JS 在切到别的 App 后会被系统
// 节流甚至冻结，等网页发现「TA 打开了抖音」再拉回小手机，往往已经过了几十秒。
// 原生无障碍服务本来就实时收到前台包名事件，把判断放在那里才能做到
// 「一打开就拦」。网页只负责把用户配置写过去，不在每次事件里参与。

import type { PerceptionConfig } from "./types";

type GuardBridgeLike = {
  setAppGuardConfig?: (json: string) => void;
  getAppGuardConfig?: () => string;
  bringToFront?: () => boolean;
};

function bridge(): GuardBridgeLike | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { AndroidShell?: GuardBridgeLike }).AndroidShell;
  return candidate && typeof candidate === "object" ? candidate : null;
}

/** 当前壳是否支持原生应用守卫（老 APK 没有）。 */
export function supportsAppGuard(): boolean {
  return typeof bridge()?.setAppGuardConfig === "function";
}

/**
 * 把守卫配置写到原生。非壳环境 / 老壳静默跳过。
 *
 * 每次启动引擎和保存设置时都调一次：原生侧持久化在 SharedPreferences，
 * 进程重启后仍然生效，不依赖网页还活着。
 */
export function syncAppGuardToNative(config: PerceptionConfig): void {
  const guard = bridge();
  if (!guard?.setAppGuardConfig) return;
  try {
    guard.setAppGuardConfig(JSON.stringify({
      // 总开关关掉时整体失效，避免用户关了感知却还被拦。
      enabled: config.enabled,
      watchList: config.appOpenWatchList,
      returnToFloat: config.appOpenReturnToFloat,
      sleepLockEnabled: config.sleepLockEnabled,
      sleepLockStart: config.sleepLockStart,
      sleepLockEnd: config.sleepLockEnd,
      sleepLockApps: config.sleepLockApps,
      sleepLockMessage: config.sleepLockMessage,
    }));
  } catch {
    // 桥异常绝不能让感知引擎启动失败
  }
}

/** 让壳把小手机自己拉到前台（睡眠遮罩的「回小手机」按钮也走这条）。 */
export function bringAppToFront(): boolean {
  try {
    return bridge()?.bringToFront?.() === true;
  } catch {
    return false;
  }
}
