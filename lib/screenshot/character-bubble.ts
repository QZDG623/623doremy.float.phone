"use client";

// 角色气泡的「逐句播放」。
//
// 为什么不能一次把整段回复塞进一个气泡：
//   原生气泡最多四行，长回复会被截断；而且一条覆盖整段的气泡读起来像通知，
//   不像角色在旁边小声说。这里把回复按句切开，一句一句出现、消失、再出现，
//   每句都完整显示（时长按字数算），句与句之间留一点空白。
//
// 与悬浮球的关系：播放期间让悬浮球「呼吸」（透明度缓慢起伏），
// 让人看得出角色此刻正在看屏/正在说话；气泡本身由原生挂在球旁边并跟随球移动。

import { setBallThinking, showSubtitle } from "./bridge";

/** 每句最少/最多显示多久（毫秒）。太短来不及读完，太长像卡住。 */
const MIN_SENTENCE_MS = 2600;
const MAX_SENTENCE_MS = 5200;
/** 句与句之间的空档：让上一句消失、下一句再出现。 */
const GAP_MS = 360;
/** 一次最多播几句：再多就不是「两三句话」了，后面的留给聊天记录。 */
const MAX_SENTENCES = 6;

/** 播放序号：新的一轮直接顶掉旧的一轮，避免两段回复的气泡互相插嘴。 */
let playToken = 0;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * 把一段回复切成适合逐句展示的句子。
 *
 * 规则尽量朴素：先按换行切，再按中文/英文句末标点切；引号与括号里的标点
 * 不单独成句。返回时已经去掉了空句与多余空白。
 */
export function splitBubbleSentences(text: string): string[] {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#*_>`]/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!cleaned) return [];

  const sentences: string[] = [];
  for (const line of cleaned.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 句末标点后切；连续的标点（！？…）跟着前一句走，不切成空句
    const parts = trimmed.split(/(?<=[。！？!?…])\s*/).map(part => part.trim()).filter(Boolean);
    for (const part of parts) sentences.push(part);
  }
  return sentences;
}

/**
 * 逐句弹气泡。永远不抛：气泡是附加表现，失败不该影响聊天与感知链路。
 *
 * @param text 角色回复原文（可带换行/标记，内部会清理）
 */
export async function speakInBubbles(text: string, options?: { signal?: boolean }): Promise<void> {
  const sentences = splitBubbleSentences(text).slice(0, MAX_SENTENCES);
  if (!sentences.length) return;

  const token = ++playToken;
  // 原生气泡接口不可用时（老 APK / 浏览器），直接跳过——没有球也没有地方挂。
  const thinking = options?.signal !== false;
  if (thinking) setBallThinking(true);
  try {
    for (let i = 0; i < sentences.length; i++) {
      if (token !== playToken) return;
      if (i > 0) await sleep(GAP_MS);
      if (token !== playToken) return;
      const sentence = sentences[i];
      // 时间随字数走，但夹在上下限之间：短句不至于一闪而过，长句也读得完。
      const duration = Math.min(MAX_SENTENCE_MS, Math.max(MIN_SENTENCE_MS, sentence.length * 170));
      showSubtitle(sentence, duration);
      await sleep(duration);
    }
  } finally {
    if (thinking) setBallThinking(false);
  }
}

/** 打断正在播放的气泡序列（例如新的看屏轮次开始时）。 */
export function stopBubbleSequence(): void {
  playToken += 1;
  setBallThinking(false);
}
