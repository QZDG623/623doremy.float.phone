import { kvGet, kvSet, registerKvMigration } from "./kv-db";

// 「通用生成能力」是剧情应用级别的开关：所有角色、多人组、主线和分线共用同一套。
// 状态栏/小剧场是否生成属于角色设置，放在 StoryCharacterSettings 里，不放这里。

const STORAGE_KEY = "story-generation-prefs-v1";
registerKvMigration(STORAGE_KEY);

export const STORY_GENERATION_PREFS_EVENT = "story-generation-prefs-updated";

export type StoryGenerationPrefs = {
  /** 进入剧情时中止当前角色正在进行的后台主动发消息请求。 */
  interruptBackgroundMessages: boolean;
  /** 剧情正文按模型返回实时显示；接口不支持流式时自动回退普通生成。 */
  streamOutput: boolean;
  /** 每轮注入当前真实日期时间，并按时间先后理解历史。 */
  timeAware: boolean;
};

export const STORY_DEFAULT_GENERATION_PREFS: StoryGenerationPrefs = {
  interruptBackgroundMessages: true,
  streamOutput: true,
  timeAware: true,
};

export function loadStoryGenerationPrefs(): StoryGenerationPrefs {
  if (typeof window === "undefined") return { ...STORY_DEFAULT_GENERATION_PREFS };
  try {
    const parsed = JSON.parse(kvGet(STORAGE_KEY) || "{}") as Partial<StoryGenerationPrefs>;
    return {
      interruptBackgroundMessages: parsed.interruptBackgroundMessages !== false,
      streamOutput: parsed.streamOutput !== false,
      timeAware: parsed.timeAware !== false,
    };
  } catch {
    return { ...STORY_DEFAULT_GENERATION_PREFS };
  }
}

export function saveStoryGenerationPrefs(next: StoryGenerationPrefs): StoryGenerationPrefs {
  const normalized: StoryGenerationPrefs = {
    interruptBackgroundMessages: next.interruptBackgroundMessages !== false,
    streamOutput: next.streamOutput !== false,
    timeAware: next.timeAware !== false,
  };
  if (typeof window !== "undefined") {
    kvSet(STORAGE_KEY, JSON.stringify(normalized));
    window.dispatchEvent(new CustomEvent(STORY_GENERATION_PREFS_EVENT, { detail: normalized }));
  }
  return normalized;
}

// ── 剧情前台状态 ────────────────────────────────────────────
// 剧情页在场时登记当前角色；后台主动发消息的逻辑据此判定是否要让路。

let foregroundCharacterIds = new Set<string>();
// 正在后台生成剧情的角色：即使剧情页已经切走，生成结束前后台主动发消息也应继续让路
let generatingCharacterIds = new Set<string>();

export function setStoryForegroundCharacters(ids: string[] | null): void {
  foregroundCharacterIds = new Set((ids || []).filter(Boolean));
}

export function setStoryGeneratingCharacters(ids: string[] | null): void {
  generatingCharacterIds = new Set((ids || []).filter(Boolean));
}

export function isStoryForegroundForCharacter(characterId: string | undefined | null): boolean {
  return Boolean(characterId && foregroundCharacterIds.has(characterId));
}

/** 后台主动发消息是否应让路给剧情（开关关闭时永不让路）。 */
export function storyBlocksBackgroundActivity(characterId: string | undefined | null): boolean {
  if (!characterId) return false;
  if (!loadStoryGenerationPrefs().interruptBackgroundMessages) return false;
  return foregroundCharacterIds.has(characterId) || generatingCharacterIds.has(characterId);
}
