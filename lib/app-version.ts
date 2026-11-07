/**
 * 网页端构建版本。
 *
 * 与 public/sw.js 的 CACHE_VERSION 同步递增：升版会让客户端丢掉旧 JS。
 * 设置 → 运行诊断 会显示这个值，用来确认设备实际加载的是不是最新构建
 * （旧 APK/旧缓存可能一直跑着老 JS，光看界面看不出来）。
 */
export const WEB_BUILD_VERSION = "v44";
