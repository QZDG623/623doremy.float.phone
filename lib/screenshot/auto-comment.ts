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
//   ④ 模型回复先过一道「是否真的提到了屏幕上的内容」检查，再弹成字幕气泡。
//
// 为什么不再复用 requestBackgroundChatReply：
//   那条路径会把整段聊天历史送进模型，模型很容易顺着聊天往下说，气泡就变成
//   角色自说自话。这里只用「角色设定 + 这一屏文字」做一次专用生成，并把
//   最近历史压到空，从机制上断掉「接着聊天聊」的惯性。
//
// 边界：
//   · 读屏只用于**当轮**生成，不落库、不外传（模型请求除外，这正是功能本身）；
//   · 生成完再读一次屏：屏幕已经换了就丢弃这条气泡，避免十几秒前的回复
//     落在完全无关的页面上；
//   · 回复必须和屏幕文字有实际重合，否则重试一次，仍不重合就不显示；
//   · 屏幕文字没变化就不重复点评——刷同一个页面时不该每 3 分钟念一句；
//   · 轮数上限到了就自动停表，避免挂着不管把额度烧光（0 = 不限）。

import { simpleLLMCall } from "../api-helpers";
import { buildChatPromptMessages } from "../chat-engine";
import { loadChatMessages, loadChatSessions, pushChatMessage } from "../chat-storage";
import {
  readScreenText,
  setBallThinking,
  startScreenTicker,
  stopScreenTicker,
  supportsScreenTicker,
} from "./bridge";
import { speakInBubbles } from "./character-bubble";
import { loadScreenshotConfig } from "./config";
import type { ScreenTextRead } from "./types";

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
function pickSession(): ReturnType<typeof loadChatSessions>[number] | null {
  try {
    const sessions = loadChatSessions()
      .filter(session => !session.isGroup)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sessions[0] ?? null;
  } catch {
    return null;
  }
}

/** 把模型回复清理成气泡可用的文本（去标记、压空白；不截断，交给逐句播放）。 */
function toBubbleText(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#*_>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 常见前台包名 → 给人/模型看的中文名（取不到就用包名本身）。 */
const PACKAGE_LABELS: Record<string, string> = {
  "com.tencent.mm": "微信",
  "com.tencent.mobileqq": "QQ",
  "com.xingin.xhs": "小红书",
  "com.ss.android.ugc.aweme": "抖音",
  "com.sina.weibo": "微博",
  "com.zhihu.android": "知乎",
  "tv.danmaku.bili": "哔哩哔哩",
  "com.taobao.taobao": "淘宝",
  "com.netease.cloudmusic": "网易云音乐",
  "com.android.chrome": "浏览器",
  "app.floatphone.shell": "小手机",
};

function describePackage(pkg: string): string {
  if (!pkg) return "";
  if (PACKAGE_LABELS[pkg]) return PACKAGE_LABELS[pkg];
  const lower = pkg.toLowerCase();
  if (lower.includes("floatphone")) return "小手机";
  return pkg;
}

/** 拼出「这一屏是什么」的提示，塞在最后一条 system 消息里。 */
function buildScreenNote(screen: ScreenTextRead, strict = false): string {
  const appLabel = describePackage(screen.pkg);
  const text = screen.text.slice(0, SCREEN_PROMPT_CHARS);
  const lines = [
    `（你刚瞥了一眼 TA 手机屏幕上的内容${appLabel ? `，现在停在「${appLabel}」` : ""}。屏幕上可见的文字是：`,
    `"""${text}"""`,
    "这是 TA 此刻真实看到的画面。请像坐在旁边一样，就屏幕上**具体出现的内容**主动小声说两三句：",
    "· 第一句必须原样引用屏幕上出现的一个具体名词或半句原话（比如屏幕上的名字、菜名、题目、聊天里的词），让 TA 一听就知道你在看同一块屏幕；",
    "· 不要接着之前的聊天往下说，不要问 TA 在做什么，也不要说与这块屏幕无关的事；",
    "· 用两到三句口语短句，不要列表、不要复述整屏文字、不要输出旁白或状态面板。）",
  ];
  if (strict) {
    lines.push(`（上一次回复没有提到屏幕上的任何内容。这一次第一句必须直接引用屏幕里出现过的词或原话，例如：「……${text.slice(0, 24)}」里的那个词。）`);
  }
  return lines.join("\n");
}

/**
 * 专用看屏生成：只用角色设定 + 这一屏文字，不喂聊天历史。
 *
 * 走 buildChatPromptMessages 拿到完整人设/世界书，再用 simpleLLMCall 直接发请求：
 * 避开 requestBackgroundChatReply 的完整历史与富媒体解析，也不挂离线兜底。
 */
async function requestScreenComment(
  session: ReturnType<typeof loadChatSessions>[number],
  screen: ScreenTextRead,
  strict = false,
): Promise<string> {
  const { llmMessages, config } = await buildChatPromptMessages(session, [], {
    appTags: ["chat", "text"],
    ephemeralSystemNote: buildScreenNote(screen, strict),
  });
  const messages = llmMessages
    .map(message => ({
      role: message.role,
      content: typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map(part => ("text" in part ? part.text : "")).join("\n")
          : "",
    }))
    .filter(message => message.content.trim().length > 0);
  const result = await simpleLLMCall(config, messages, {
    temperature: 0.8,
    max_tokens: 320,
    label: "看屏",
  });
  return toBubbleText(result.content ?? "");
}

const CJK_RUN = /[\u4e00-\u9fff]+/g;

/** 看屏时真正喂给模型的屏幕文字长度（与 buildScreenNote 一致）。 */
const SCREEN_PROMPT_CHARS = 1400;

/**
 * 回复是否真的沾着屏幕内容。
 *
 * 中文以 3 字滑窗比对：只说「你的」「真的」「我们」这类虚词不会命中，
 * 必须说中屏幕上的具体名词（"火锅"、"糖醋排骨"、"言语理解"）。
 * 2 字重合至少 4 处也算（长句里刻意点到多个屏幕词的情况）。
 * 英文按 4 字母以上的词比对。
 */
function mentionsScreen(reply: string, screenText: string): boolean {
  if (!reply.trim()) return false;
  const replyCjk = (reply.match(CJK_RUN) ?? []).join("");
  const screenCjk = (screenText.slice(0, SCREEN_PROMPT_CHARS).match(CJK_RUN) ?? []).join("");
  const screenGrams = new Set<string>();
  for (let i = 0; i + 3 <= screenCjk.length; i++) screenGrams.add(screenCjk.slice(i, i + 3));
  for (let i = 0; i + 3 <= replyCjk.length; i++) {
    if (screenGrams.has(replyCjk.slice(i, i + 3))) return true;
  }
  const screenBigrams = new Set<string>();
  for (let i = 0; i + 2 <= screenCjk.length; i++) screenBigrams.add(screenCjk.slice(i, i + 2));
  let sharedBigrams = 0;
  const counted = new Set<string>();
  for (let i = 0; i + 2 <= replyCjk.length; i++) {
    const gram = replyCjk.slice(i, i + 2);
    if (screenBigrams.has(gram) && !counted.has(gram)) {
      counted.add(gram);
      sharedBigrams += 1;
    }
  }
  if (sharedBigrams >= 4) return true;
  const replyWords = reply.match(/[A-Za-z][A-Za-z0-9]{3,}/g) ?? [];
  const screenLower = screenText.toLowerCase();
  return replyWords.some(word => screenLower.includes(word.toLowerCase()));
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
  const session = pickSession();
  if (!session) return;

  busy = true;
  // 看屏思考期间让悬浮球呼吸：用户能看出「角色真的在看屏」，
  // 而不是盯着一个毫无反应的球猜它到底有没有在工作。
  setBallThinking(true);
  try {
    let text = await requestScreenComment(session, screen);
    // 第一遍没提到屏幕内容就重试一次；仍不沾边宁可不显示，也不让角色自说自话
    if (!mentionsScreen(text, screen.text)) {
      text = await requestScreenComment(session, screen, true);
    }
    if (!text || !mentionsScreen(text, screen.text)) return;

    // 生成可能要几十秒：说之前再确认一次屏幕没换，避免把上一屏的点评
    // 弹在完全无关的页面上（用户切 App 时最常撞见这种错位）。
    const latest = readScreenText();
    if (!latest || latest.text.slice(0, 400) !== key) return;

    lastScreenKey = key;
    roundsThisRun += 1;

    // 照旧落一条到聊天里，聊天记录和气泡是同一句；
    // 气泡本身直接播这句，不再去聊天里「猜哪条是刚生成的」。
    pushChatMessage({ sessionId: session.id, role: "assistant", content: text });

    if (config.subtitleEnabled) {
      // 逐句播放：每句完整出现、停留、消失，再出下一句。
      // 不在这里限长——截断正是之前「只能看到一句话」的原因。
      await speakInBubbles(text);
    }

    // 轮数刚好用满：立刻停表，不必等到下一个节拍
    if (config.autoCommentMaxRounds > 0 && roundsThisRun >= config.autoCommentMaxRounds) {
      stopAutoCommentTicker();
    }
  } catch {
    // 读屏/生成失败：这一轮跳过，不写任何聊天记录
  } finally {
    setBallThinking(false);
    busy = false;
  }
}
