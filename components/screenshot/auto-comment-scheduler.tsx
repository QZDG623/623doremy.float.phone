"use client";

// 自主回复调度器：把「原生看屏节拍」与网页侧生成接起来。
//
// 为什么必须常驻而不能挂在截屏设置页：
//   · 节拍是**原生**推的（后台 JS 定时器会被冻结），但收到事件后要读屏、
//     生成回复、弹字幕，这一段只能在网页里做；
//   · 用户开启自主回复后多半回到桌面或别的 App，设置页早就没了。
//     调度器挂在 main-app（和 CheckInScheduler 同层）才等得到事件。
//
// 只做三件事：对齐节拍、收 screen-tick、配置变了重新对齐。真正的
// 读屏/生成逻辑在 lib/screenshot/auto-comment.ts，这里不掺业务。

import { useEffect } from "react";

import {
  ensureShellOverlayListener,
  subscribeShellOverlayEvents,
} from "@/lib/shell-call-overlay";
import {
  handleScreenTick,
  stopAutoCommentTicker,
  syncAutoCommentTicker,
} from "@/lib/screenshot/auto-comment";

export function AutoCommentScheduler() {
  useEffect(() => {
    syncAutoCommentTicker();
    ensureShellOverlayListener();

    const unsubscribe = subscribeShellOverlayEvents((event) => {
      if (event.action !== "screen-tick") return;
      void handleScreenTick();
    });

    // 设置页改动（开关/间隔/轮数）后立刻对齐节拍；关掉时由
    // syncAutoCommentTicker 负责停表，不必等下一次事件。
    const onConfigChanged = () => syncAutoCommentTicker();
    window.addEventListener("screenshot-config-changed", onConfigChanged);

    // 回到前台补一次对齐：进程被重建、原生节拍掉了都要靠这一刻补上。
    const onResume = () => syncAutoCommentTicker();
    window.addEventListener("pageshow", onResume);
    document.addEventListener("visibilitychange", onResume);

    return () => {
      unsubscribe();
      window.removeEventListener("screenshot-config-changed", onConfigChanged);
      window.removeEventListener("pageshow", onResume);
      document.removeEventListener("visibilitychange", onResume);
      stopAutoCommentTicker();
    };
  }, []);

  return null;
}
