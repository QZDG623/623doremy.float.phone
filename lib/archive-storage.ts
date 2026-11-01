"use client";

// 收藏夹：聊天记录 / 剧情 / 图片 / 语音，按角色归档。
//
// 为什么单独一份存储而不是挂在消息上：
//   收藏是**快照**。原消息被删、被编辑、会话被清理之后，收藏仍然应该留着，
//   所以这里存的是当时的正文、媒体地址与角色信息，而不是一个指向消息的 id。
//
// 去重靠 sourceId（原消息 id）+ kind：重复长按同一条只会更新，不会出现两份。
// 自动归档的图片同理，用户手动删掉后会在 hidden 里留个记号，避免下次又冒出来。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const STORAGE_KEY = "ai_phone_archive_v1";
registerKvMigration(STORAGE_KEY);

/** 收藏的四类素材。 */
export type ArchiveKind = "chat" | "story" | "image" | "voice";

export const ARCHIVE_KIND_LABEL: Record<ArchiveKind, string> = {
  chat: "聊天记录",
  story: "剧情收藏",
  image: "图片",
  voice: "语音",
};

export type ArchiveEntry = {
  id: string;
  kind: ArchiveKind;
  /** 归属角色 id（群聊取会话主角色） */
  characterId: string;
  characterName: string;
  characterAvatar?: string;
  /** 原消息 id：去重与「已经收藏过」判断用 */
  sourceId: string;
  sessionId?: string;
  /** 收藏时的正文（图片/语音可能是描述或转写） */
  text: string;
  /** 媒体地址：data URL / media-store:// / asset:// 引用均可 */
  mediaUrl?: string;
  /** 原消息时间 */
  createdAt: string;
  /** 收藏动作时间 */
  savedAt: string;
  /** 是否由自动归档产生（用户删掉后不再补回） */
  auto?: boolean;
};

type ArchiveStore = {
  entries: ArchiveEntry[];
  /** 用户删掉的自动条目（sourceId），防止同步时重新出现 */
  hidden: string[];
};

function loadStore(): ArchiveStore {
  try {
    const raw = kvGet(STORAGE_KEY);
    if (!raw) return { entries: [], hidden: [] };
    const parsed = JSON.parse(raw) as Partial<ArchiveStore>;
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [],
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter(item => typeof item === "string") : [],
    };
  } catch {
    return { entries: [], hidden: [] };
  }
}

function isEntry(value: unknown): value is ArchiveEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ArchiveEntry>;
  return typeof entry.id === "string"
    && typeof entry.kind === "string"
    && typeof entry.sourceId === "string"
    && typeof entry.characterId === "string";
}

function saveStore(store: ArchiveStore): void {
  kvSet(STORAGE_KEY, JSON.stringify(store));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("archive-updated"));
  }
}

export function loadArchiveEntries(): ArchiveEntry[] {
  return loadStore().entries;
}

/** 这一条是否已经收藏过（长按菜单据此显示「已收藏」）。 */
export function isArchived(kind: ArchiveKind, sourceId: string): boolean {
  return loadStore().entries.some(entry => entry.kind === kind && entry.sourceId === sourceId);
}

/**
 * 加入一条收藏。已存在（同 kind + sourceId）则替换为新快照并返回 false。
 * 返回 true 表示确实新增了一条。
 */
export function addArchiveEntry(entry: Omit<ArchiveEntry, "id" | "savedAt">): boolean {
  const store = loadStore();
  const savedAt = new Date().toISOString();
  const index = store.entries.findIndex(item => item.kind === entry.kind && item.sourceId === entry.sourceId);
  const next: ArchiveEntry = {
    ...entry,
    id: index >= 0 ? store.entries[index].id : `arc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    savedAt,
  };
  if (index >= 0) {
    store.entries[index] = next;
  } else {
    // 新收藏的排在最前：打开收藏夹先看到刚存的东西
    store.entries.unshift(next);
  }
  saveStore(store);
  return index < 0;
}

export function removeArchiveEntry(id: string): void {
  const store = loadStore();
  const target = store.entries.find(entry => entry.id === id);
  store.entries = store.entries.filter(entry => entry.id !== id);
  // 被删的是自动归档：记下 sourceId，别让下一次同步又把它塞回来
  if (target?.auto) {
    const key = `${target.kind}:${target.sourceId}`;
    if (!store.hidden.includes(key)) store.hidden.push(key);
    if (store.hidden.length > 500) store.hidden = store.hidden.slice(-500);
  }
  saveStore(store);
}

export type ArchiveGroup = {
  characterId: string;
  characterName: string;
  characterAvatar?: string;
  entries: ArchiveEntry[];
  /** 档案编号（稳定、按角色 id 派生，不随排序变化） */
  code: string;
};

/** 按角色分组，最近收藏的排前面。 */
export function groupArchiveByCharacter(entries: ArchiveEntry[]): ArchiveGroup[] {
  const groups = new Map<string, ArchiveGroup>();
  for (const entry of entries) {
    const key = entry.characterId || "unknown";
    let group = groups.get(key);
    if (!group) {
      group = {
        characterId: key,
        characterName: entry.characterName || "未分组",
        characterAvatar: entry.characterAvatar,
        entries: [],
        code: archiveCode(key),
      };
      groups.set(key, group);
    }
    group.entries.push(entry);
    // 头像可能后补：用最新一条里带的头像
    if (entry.characterAvatar) group.characterAvatar = entry.characterAvatar;
  }
  return [...groups.values()]
    .map(group => ({
      ...group,
      entries: group.entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
    }))
    .sort((a, b) => {
      const at = a.entries[0]?.savedAt ?? "";
      const bt = b.entries[0]?.savedAt ?? "";
      return bt.localeCompare(at);
    });
}

/** 档案编号：PF-xxxx，由角色 id 稳定派生——同一个人每次打开都是同一个号。 */
function archiveCode(characterId: string): string {
  let hash = 0;
  for (let i = 0; i < characterId.length; i++) {
    hash = (hash * 31 + characterId.charCodeAt(i)) >>> 0;
  }
  const code = (hash % 9000 + 1000).toString();
  return `PF-${code}`;
}

// ── 自动归档生成的图片 ────────────────────────────

/** 自动归档的状态提示，给调用方做「已同步 N 张」之类反馈。 */
export const ARCHIVE_IMAGE_LIMIT = 300;

/**
 * 扫描聊天库里角色生成的图片，自动归档进收藏夹。
 *
 * 只取「角色发的图」（role=assistant、mediaType=image），用户自己发的图不自动收藏——
 * 收藏夹是「角色留下的东西」，把用户相册也搬进来只会变成第二个相册。
 *
 * 异步读 IndexedDB，失败静默（收藏夹打不开也不该报错）。
 */
export async function syncGeneratedChatImages(): Promise<number> {
  try {
    const { chatDb } = await import("./chat-db");
    const { loadCharacters } = await import("./character-storage");
    const messages = await chatDb.messages
      .orderBy("createdAt")
      .reverse()
      .limit(3000)
      .toArray();
    const sessions = await chatDb.sessions.toArray();
    const characters = loadCharacters();
    const sessionById = new Map(sessions.map(session => [session.id, session]));
    const characterById = new Map(characters.map(character => [character.id, character]));

    const store = loadStore();
    const hidden = new Set(store.hidden);
    const known = new Set(store.entries.map(entry => `${entry.kind}:${entry.sourceId}`));

    let added = 0;
    for (const message of messages) {
      if (added >= ARCHIVE_IMAGE_LIMIT) break;
      if (message.role !== "assistant" || message.mediaType !== "image" || !message.mediaUrl) continue;
      const session = sessionById.get(message.sessionId);
      if (!session || session.isGroup) continue;
      const character = characterById.get(session.contactId);
      const characterName = character?.name || session.alias || "角色";
      const sourceId = message.id;
      const key = `image:${sourceId}`;
      if (hidden.has(key) || known.has(key)) continue;

      const description = message.mediaData?.label?.trim() || message.content?.trim() || "";
      store.entries.unshift({
        id: `arc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        kind: "image",
        characterId: session.contactId,
        characterName,
        characterAvatar: character?.avatar || undefined,
        sourceId,
        sessionId: session.id,
        text: description || "角色生成的一张图",
        mediaUrl: message.mediaUrl,
        createdAt: message.createdAt,
        savedAt: new Date().toISOString(),
        auto: true,
      });
      known.add(key);
      added += 1;
    }
    if (added > 0) saveStore(store);
    return added;
  } catch {
    return 0;
  }
}
