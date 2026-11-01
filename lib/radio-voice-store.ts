import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { saveChatAudioToIndexedDB } from "./chat-asset-storage";

// 睡眠电台的「其它 App 语音」收纳处：剧情、漫卷之外的 App 在合成好一段语音后
// 调一次 recordRadioVoice，把音频本体存进资产库，电台就能长期播放。
// 只收已经真实合成出来的音频（调用方拿到 Blob 才写），不做二次合成。

const STORAGE_KEY = "ai_phone_radio_voices_v1";
const MAX_RECORDS = 400;
registerKvMigration(STORAGE_KEY);

export const RADIO_VOICES_EVENT = "radio-voices-updated";

export type RadioVoiceRecord = {
  id: string;
  characterId: string;
  characterName: string;
  characterAvatar?: string;
  text: string;
  /** 资产库引用 asset://... */
  mediaUrl: string;
  createdAt: string;
};

export function loadRadioVoices(): RadioVoiceRecord[] {
  try {
    const parsed = JSON.parse(kvGet(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is RadioVoiceRecord => Boolean(
      item
      && typeof item.id === "string"
      && typeof item.characterId === "string"
      && typeof item.mediaUrl === "string"
      && item.mediaUrl.startsWith("asset://"),
    ));
  } catch {
    return [];
  }
}

export type RecordRadioVoiceInput = {
  /** 稳定来源 id：同一个语音重复合成时替换旧的那条，而不是不断堆新条目。 */
  id: string;
  characterId?: string;
  characterName?: string;
  characterAvatar?: string;
  text: string;
  createdAt?: string;
};

export async function recordRadioVoice(blob: Blob | null | undefined, input: RecordRadioVoiceInput): Promise<void> {
  if (!blob || blob.size <= 0) return;
  const text = input.text.trim();
  if (!text) return;
  try {
    const assetId = await saveChatAudioToIndexedDB(blob);
    const mediaUrl = `asset://${assetId}`;
    const record: RadioVoiceRecord = {
      id: input.id,
      characterId: input.characterId || "unknown",
      characterName: input.characterName || "未分组",
      characterAvatar: input.characterAvatar || undefined,
      text,
      mediaUrl,
      createdAt: input.createdAt || new Date().toISOString(),
    };
    const existing = loadRadioVoices();
    const next = [record, ...existing.filter((item) => item.id !== record.id)].slice(0, MAX_RECORDS);
    kvSet(STORAGE_KEY, JSON.stringify(next));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(RADIO_VOICES_EVENT));
  } catch {
    /* 存不进资产库就算了，不影响当前播放 */
  }
}
