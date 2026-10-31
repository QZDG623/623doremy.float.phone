"use client";

// 自主回复：角色隔一段时间自己看一眼你的屏幕，然后主动说一句。
//
// 与「截屏」的关系：截屏是用户点一下才发生的一次性动作；这里是持续性的
// 读屏 + 点评，所以默认关、受轮数上限约束，并且只在用户明确开启后才运行。
//
// 链路（为什么要绕这么大一圈）：
//   ① 节拍由**原生**托管（ScreenshotBridge.startTicker）——网页在后台时
//      JS 定时器会被系统冻结，交给原生才能在你刷别的 App 时准点触发；
//   ② 原生到点推一条 screen-tick 事件，网页（本模块）收到后读屏文字；
//   ③ 文字作为一句「临时系统提示」塞进模型请求，让角色当作自己瞥见的，
//      不写进聊天记录——否则下一次对话它会把这段屏幕内容当成用户说过的话；
//   ④ 模型的回复照常落进聊天（复用 requestBackgroundChatReply），
//      再取最新一条弹成屏幕字幕气泡。
//
// 边界：
//   · 读屏只用于**当轮**生成，不落库、不外传（模型请求除外，这正是功能本身）；
//   · 屏幕文字没变化就不重复点评——刷同一个页面时不该每 3 分钟念一句；
//   · 轮数上限到了就自动停表，避免挂着不管把额度烧光（0 = 不限）。

import { loadChatMessages, loadChatSessions } from "../chat-storage";
import { requestBackgroundChatReply } from "../follow-up-service";
import {
  readScreenText,
  showSubtitle,
  startScreenTicker,
  stopScreenTicker,
  supportsScreenTicker,
} from "./bridge";
import { loadScreenshotConfig } from "./config";

/** 本次「开启自主回复」以来已经自动说了几轮。关闭/重开时清零。 */
let roundsThisRun = 0;
/** 正在生成中：一次模型调用可能几十秒，不能叠加。 */
let busy = false;
/** 上一次点评过的屏幕内容指纹（前 400 字），用来「没变化就不说」。 */
let lastScreenKey = "";
/** 节拍是否已经在跑（用于「刚开启时重置轮数」）。 */
let tickerOn = false;

/** 把节拍与本地配置对齐。设置页改动、App 启动、回到前台时调用。 */
export function syncAutoCommentTicker(): void {
  const config = loadScreenshotConfig();
  const want = config.enabled && config.autoCommentEnabled && supportsScreenTicker();
  if (want) {
    // 从关到开：这是新的一轮，重置计数与去重基准
    if (!tickerOn) {
      roundsThisRun = 0;
      lastScreenKey = "";
    }
    startScreenTicker(config.autoCommentSeconds);
    tickerOn = true;
    return;
  }
  stopScreenTicker();
  tickerOn = false;
}

/** 关闭自主回复（或页面卸载）时停表。 */
export function stopAutoCommentTicker(): void {
  stopScreenTicker();
  tickerOn = false;
}

/** 本次运行已自动说了几轮（设置页展示用）。 */
export function readAutoCommentRounds(): number {
  return roundsThisRun;
}

/** 取最近聊过的私聊会话：角色此刻最可能在陪着的那个。 */
function pickSessionId(): string | null {
  try {
    const sessions = loadChatSessions()
      .filter(session => !session.isGroup)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sessions[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** 把模型回复清理成适合字幕气泡的一行（去标记、压空白、限长）。 */
function toSubtitleText(content: string): string {
  const cleaned = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#*_>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 120);
}

/**
 * 处理一次原生看屏节拍。
 *
 * 永远不抛：节拍是后台行为，任何失败都该静默跳过，而不是把聊天/页面拖崩。
 */
export async function handleScreenTick(): Promise<void> {
  const config = loadScreenshotConfig();
  if (!config.enabled || !config.autoCommentEnabled || !config.screenTextEnabled) return;
  if (busy) return;
  if (config.autoCommentMaxRounds > 0 && roundsThisRun >= config.autoCommentMaxRounds) {
    // 轮数用完就停表，等用户重新开启才恢复
    stopAutoCommentTicker();
    return;
  }

  const screen = readScreenText();
  if (!screen) return;
  const key = screen.text.slice(0, 400);
  if (key === lastScreenKey) return;
  const sessionId = pickSessionId();
  if (!sessionId) return;

  busy = true;
  const startedAt = Date.now();
  try {
    const note = `（你这会儿顺手看到 TA 手机屏幕上的内容：${screen.text.slice(0, 1200)}。`
      + "如果你正好有感觉，就随口说一句像陪在旁边看到时的反应——"
      + "别复述屏幕内容、别列清单、一两句话就够。不想说就保持安静。）";
    const result = await requestBackgroundChatReply(sessionId, { ephemeralSystemNote: note });
    if (!result.ok) return;

    lastScreenKey = key;
    roundsThisRun += 1;

    if (config.subtitleEnabled) {
      const messages = loadChatMessages(sessionId, 10);
      const latest = [...messages].reverse().find(msg => (
        msg.role === "assistant"
        && new Date(msg.createdAt).getTime() >= startedAt
        && typeof msg.content === "string"
        && msg.content.trim().length > 0
      ));
      if (latest) {
        const text = toSubtitleText(latest.content);
        if (text) showSubtitle(text, 7000);
      }
    }

    // 轮数刚好用满：立刻停表，不必等到下一个节拍
    if (config.autoCommentMaxRounds > 0 && roundsThisRun >= config.autoCommentMaxRounds) {
      stopAutoCommentTicker();
    }
  } catch {
    // 读屏/生成失败：这一轮跳过，不写任何聊天记录
  } finally {
    busy = false;
  }
}
