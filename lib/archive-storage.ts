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

// ── 语音收藏：把音频本体留下来 ─────────────────────
//
// 聊天里的语音条以前只存了文字转写，音频要么还没合成、要么被存储清理置空，
// 收藏进档案后只剩一行字（「语音文件已被清理」）。收藏是快照，音频也必须
// 一起留下来：这里把现有音频转存进资产库，没有就把文字重新合成一次，
// 档案里的地址改成 asset:// 引用，可以反复播放。

/** 存进资产库（与聊天图片同一套 IndexedDB），返回可长期引用的 asset:// 地址。 */
async function storeVoiceAsset(blob: Blob): Promise<string | null> {
  try {
    const { saveChatAudioToIndexedDB } = await import("./chat-asset-storage");
    const id = await saveChatAudioToIndexedDB(blob);
    return `asset://${id}`;
  } catch {
    return null;
  }
}

/** 把任意媒体地址转成收藏夹能长期播放的地址；转不了返回 null。 */
async function durableVoiceUrl(raw?: string): Promise<string | null> {
  const url = raw?.trim();
  if (!url) return null;
  if (url.startsWith("asset://")) return url;
  try {
    if (url.startsWith("data:") || url.startsWith("blob:")) {
      return await storeVoiceAsset(await (await fetch(url)).blob());
    }
    if (url.startsWith("media-store://")) {
      const { loadMediaBlob } = await import("./media-cache-storage");
      const loaded = await loadMediaBlob(url);
      return loaded ? await storeVoiceAsset(loaded.blob) : null;
    }
  } catch {
    return null;
  }
  // http(s) 等本来就能长期访问的地址直接用
  return url;
}

/** 用角色的语音配置把文字合成一段音频，并转存进资产库。 */
async function synthesizeVoiceAsset(characterId: string, text: string): Promise<string | null> {
  const speakable = text.trim();
  if (!speakable) return null;
  try {
    const { resolveVoiceConfigCandidates, synthesizeSpeech } = await import("./tts-service");
    const configs = resolveVoiceConfigCandidates(characterId);
    for (const config of configs.slice(0, 3)) {
      try {
        const blob = await synthesizeSpeech(speakable, config);
        if (blob) return await storeVoiceAsset(blob);
      } catch {
        /* 换下一个可用方案 */
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 收藏里那条语音地址**现在还能不能播**。
 *
 * 旧收藏常常存着当年聊天里的 media-store:// 引用，那条音频后来被存储清理
 * 删掉了，地址仍然留着——只看「有没有 mediaUrl」会误判成已修好，
 * 界面就一直显示「语音文件已被清理」。这里真的去取一次。
 */
async function isVoiceRefAlive(raw?: string): Promise<boolean> {
  const url = raw?.trim();
  if (!url) return false;
  if (url.startsWith("asset://")) {
    try {
      const { getChatAudioFromIndexedDB } = await import("./chat-asset-storage");
      return Boolean(await getChatAudioFromIndexedDB(url.slice(8)));
    } catch {
      return false;
    }
  }
  if (url.startsWith("media-store://")) {
    try {
      const { loadMediaBlob } = await import("./media-cache-storage");
      return Boolean(await loadMediaBlob(url));
    } catch {
      return false;
    }
  }
  return url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("http");
}

export type ArchiveVoiceInput = {
  characterId: string;
  characterName: string;
  characterAvatar?: string;
  sourceId: string;
  sessionId?: string;
  /** 展示用的台词/转写（可能带 TTS 标记，合成时会自动清洗） */
  text: string;
  mediaUrl?: string;
  createdAt: string;
};

/**
 * 收藏一条语音：优先保留已有音频；没有就按台词重新合成。
 * 合成不出来也照样收藏文字（至少不丢内容），返回 playable=false。
 */
export async function archiveVoiceMessage(input: ArchiveVoiceInput): Promise<{ status: "added" | "exists"; playable: boolean }> {
  const store = loadStore();
  const existing = store.entries.find(entry => entry.kind === "voice" && entry.sourceId === input.sourceId);
  // 已经收藏过且那条音频**确实还能播**：不重复合成
  if (existing?.mediaUrl && await isVoiceRefAlive(existing.mediaUrl)) {
    return { status: "exists", playable: true };
  }

  let mediaUrl = await durableVoiceUrl(input.mediaUrl);
  // 原消息里的地址也可能已经失效：取不出来的音频不能当作「已收藏」
  if (mediaUrl && !(await isVoiceRefAlive(mediaUrl))) mediaUrl = null;
  const speechText = input.text.trim();
  if (!mediaUrl && speechText && speechText !== "[语音]") {
    mediaUrl = await synthesizeVoiceAsset(input.characterId, speechText);
  }

  // 旧条目只有文字（或者存的地址已经失效）：这次顺手补上音频，而不是只回一句「已收藏」
  if (existing) {
    if (mediaUrl) {
      existing.mediaUrl = mediaUrl;
      saveStore(store);
    }
    return { status: "exists", playable: Boolean(mediaUrl) };
  }

  addArchiveEntry({
    kind: "voice",
    characterId: input.characterId,
    characterName: input.characterName,
    characterAvatar: input.characterAvatar,
    sourceId: input.sourceId,
    sessionId: input.sessionId,
    text: input.text,
    mediaUrl: mediaUrl ?? undefined,
    createdAt: input.createdAt,
    auto: false,
  });
  return { status: "added", playable: mediaUrl !== null };
}

/**
 * 给旧收藏里只有文字的语音补合成音频（每次打开收藏夹先补几条，
 * 合成一次就写回条目，之后打开直接播放，不会重复消耗额度）。
 */
export async function hydrateArchiveVoiceMedia(limit = 4): Promise<number> {
  const store = loadStore();
  let updated = 0;
  let inspected = 0;
  // 只检查最近的若干条：老收藏多半没人翻，不必每次打开都逐条验一遍。
  const maxInspect = limit + 6;
  for (const entry of store.entries) {
    if (updated >= limit || inspected >= maxInspect) break;
    if (entry.kind !== "voice") continue;
    inspected += 1;
    // 地址可能还在、但音频早被清理了：真的取一次再决定要不要重合成
    if (entry.mediaUrl && await isVoiceRefAlive(entry.mediaUrl)) continue;
    const text = entry.text?.trim();
    if (!text || text === "[语音]") continue;
    const mediaUrl = await synthesizeVoiceAsset(entry.characterId, text);
    if (!mediaUrl) {
      // 合成也失败：把失效地址清掉，界面至少不会一直说「已被清理」
      if (entry.mediaUrl) {
        entry.mediaUrl = undefined;
        updated += 1;
      }
      continue;
    }
    entry.mediaUrl = mediaUrl;
    updated += 1;
  }
  if (updated > 0) saveStore(store);
  return updated;
}

// ── 自动归档生成的图片 ────────────────────────────

/** 自动归档的状态提示，给调用方做「已同步 N 张」之类反馈。 */
export const ARCHIVE_IMAGE_LIMIT = 300;

/**
 * 其他 App（自定义 App 的 ai.generateImage）生成了一张图：直接归档。
 *
 * 这类图不进聊天记录，也没有朋友圈帖子，扫描不到，所以生成成功时就地存一份。
 * 只收「带角色 id」的图——没有角色就不知道该归到谁的档案里。
 */
export async function archiveGeneratedImage(input: {
  characterId: string;
  characterName?: string;
  characterAvatar?: string;
  sourceId?: string;
  text?: string;
  blob: Blob;
}): Promise<boolean> {
  try {
    const { saveChatImageToIndexedDB } = await import("./chat-asset-storage");
    const assetId = await saveChatImageToIndexedDB(input.blob);
    if (!assetId) return false;
    let characterName = input.characterName?.trim() || "";
    let characterAvatar = input.characterAvatar?.trim() || undefined;
    if (!characterName) {
      try {
        const { loadCharacters } = await import("./character-storage");
        const character = loadCharacters().find(item => item.id === input.characterId);
        characterName = character?.name || "角色";
        characterAvatar = characterAvatar || character?.avatar || undefined;
      } catch {
        characterName = "角色";
      }
    }
    return addArchiveEntry({
      kind: "image",
      characterId: input.characterId,
      characterName,
      characterAvatar,
      sourceId: input.sourceId || `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      text: input.text?.trim() || "角色生成的一张图",
      mediaUrl: `asset://${assetId}`,
      createdAt: new Date().toISOString(),
      auto: true,
    });
  } catch {
    return false;
  }
}

/** 一条消息/帖子是不是「角色这边的一张图」。 */
function isImageContent(mediaType: string | undefined, mediaData: unknown, fileName: string): boolean {
  if (mediaType === "image") return true;
  if (mediaType !== "media_file") return false;
  const data = (mediaData ?? {}) as { fileType?: string };
  return data.fileType === "image" || /\.(png|jpe?g|webp|gif)$/i.test(fileName);
}

/**
 * 把任意图片地址转成资产库引用（asset://），转不了就返回 null。
 *
 * 只收藏**真的能取到图片字节**的条目：生成失败、还没生成（只有文字描述）
 * 或者图片已经被存储清理的消息一律不收。旧收藏里那些 media-store 引用
 * 也会在同步时被重新落到资产库，避免界面一直显示「图片已被清理」。
 */
async function durableImageUrl(raw?: string): Promise<string | null> {
  const url = raw?.trim();
  if (!url) return null;
  try {
    const { saveChatImageToIndexedDB, getChatImageFromIndexedDB } = await import("./chat-asset-storage");
    if (url.startsWith("asset://")) {
      const existing = await getChatImageFromIndexedDB(url.slice(8));
      return existing ? url : null;
    }
    let blob: Blob | null = null;
    if (url.startsWith("data:") || url.startsWith("blob:")) {
      blob = await (await fetch(url)).blob();
    } else if (url.startsWith("media-store://")) {
      const { loadMediaBlob } = await import("./media-cache-storage");
      blob = (await loadMediaBlob(url))?.blob ?? null;
    } else if (/^https?:/i.test(url)) {
      blob = await (await fetch(url)).blob();
    }
    if (!blob || blob.size === 0) return null;
    const id = await saveChatImageToIndexedDB(blob);
    return id ? `asset://${id}` : null;
  } catch {
    // 取不到（CORS/已清理/损坏）就当这条没有图，不收藏也不占位置
    return null;
  }
}

/** 收藏里的图片地址现在还能不能显示（真的去取一次，而不是只看有没有值）。 */
async function isImageRefAlive(raw?: string): Promise<boolean> {
  const url = raw?.trim();
  if (!url) return false;
  if (url.startsWith("asset://")) {
    try {
      const { getChatImageFromIndexedDB } = await import("./chat-asset-storage");
      return Boolean(await getChatImageFromIndexedDB(url.slice(8)));
    } catch {
      return false;
    }
  }
  if (url.startsWith("media-store://")) {
    try {
      const { loadMediaBlob } = await import("./media-cache-storage");
      return Boolean(await loadMediaBlob(url));
    } catch {
      return false;
    }
  }
  return url.startsWith("data:") || url.startsWith("blob:") || /^https?:/i.test(url);
}

/** 一条消息里当前可用的图片地址：生成图片的媒体引用优先（比 base64 小得多）。 */
function messageImageRef(message: { mediaUrl?: string; mediaData?: { imageGenerationMediaRef?: string } }): string | undefined {
  return message.mediaData?.imageGenerationMediaRef?.trim() || message.mediaUrl;
}

/**
 * 扫描各个 App 里角色生成的图片，自动归档进收藏夹。
 *
 * 覆盖：
 *   · 聊天：角色发的图片（含生成完成后变成 media_file 的图）；
 *   · 朋友圈：角色发的带图动态；
 *   · 其他 App：生成时通过 ai.generateImage 带角色 id 的图片会直接写入收藏夹。
 *
 * 用户自己发的图不自动收藏——收藏夹是「角色留下的东西」，
 * 把用户相册也搬进来只会变成第二个相册。
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
    const messageById = new Map(messages.map(message => [message.id, message]));

    let changed = false;
    let added = 0;

    // 朋友圈先读出来：后面清理旧收藏时也要能按 moment_<id> 找回原图。
    let posts: Array<{
      id: string;
      authorType: string;
      authorId: string;
      photoUrl?: string;
      photoDescription?: string;
      content?: string;
      photoGenerationStatus?: string;
      createdAt: string;
    }> = [];
    try {
      const { momentsDb } = await import("./moments-db");
      posts = await momentsDb.posts.orderBy("createdAt").reverse().limit(1000).toArray();
    } catch {
      /* 朋友圈库打不开就跳过这一块 */
    }
    const postById = new Map(posts.map(post => [post.id, post]));

    // ── 先清理旧收藏：只保留真的还能显示出来的图 ──
    // 以前的版本把「只有文字描述、图还没生成/已清理」的条目也收进来了，
    // 界面上就是一条条「图片已被清理」。原消息里还能取到图就换成资产库地址，
    // 取不到就删掉——收藏夹里不该留着空壳。
    for (const entry of [...store.entries]) {
      if (entry.kind !== "image" || !entry.auto) continue;
      if (await isImageRefAlive(entry.mediaUrl)) continue;
      const message = messageById.get(entry.sourceId);
      const post = entry.sourceId.startsWith("moment_")
        ? postById.get(entry.sourceId.slice("moment_".length))
        : undefined;
      const rawUrl = message ? messageImageRef(message) : post?.photoUrl;
      const nextUrl = await durableImageUrl(rawUrl);
      if (nextUrl) {
        entry.mediaUrl = nextUrl;
        changed = true;
      } else {
        store.entries = store.entries.filter(item => item.id !== entry.id);
        known.delete(`image:${entry.sourceId}`);
        changed = true;
      }
    }

    const pushImage = async (input: {
      sourceId: string;
      characterId: string;
      characterName: string;
      characterAvatar?: string;
      sessionId?: string;
      text: string;
      mediaUrl: string;
      createdAt: string;
    }) => {
      if (added >= ARCHIVE_IMAGE_LIMIT) return;
      const key = `image:${input.sourceId}`;
      if (hidden.has(key) || known.has(key)) return;
      // 关键：必须真的取到图片字节，并转存进资产库。只有文字描述的
      // （生成失败/还没生成）在这里会被自然过滤掉。
      const durableUrl = await durableImageUrl(input.mediaUrl);
      if (!durableUrl) return;
      store.entries.unshift({
        id: `arc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        kind: "image",
        characterId: input.characterId,
        characterName: input.characterName,
        characterAvatar: input.characterAvatar,
        sourceId: input.sourceId,
        sessionId: input.sessionId,
        text: input.text || "角色生成的一张图",
        mediaUrl: durableUrl,
        createdAt: input.createdAt,
        savedAt: new Date().toISOString(),
        auto: true,
      });
      known.add(key);
      added += 1;
      changed = true;
    };

    // ── 聊天 ──
    for (const message of messages) {
      if (added >= ARCHIVE_IMAGE_LIMIT) break;
      if (message.role !== "assistant" || !message.mediaUrl) continue;
      if (!isImageContent(message.mediaType, message.mediaData, message.content || "")) continue;
      // 生图还没完成 / 失败的，不是「生成出来的图」，不收藏
      const status = message.mediaData?.imageGenerationStatus;
      if (status === "pending" || status === "failed") continue;
      const session = sessionById.get(message.sessionId);
      if (!session) continue;

      // 群聊里按实际发言角色归；没有发言者信息就跳过，避免把图算到群主头上
      let characterId = session.contactId;
      let characterName = characterById.get(session.contactId)?.name || session.alias || "角色";
      let characterAvatar = characterById.get(session.contactId)?.avatar || undefined;
      if (session.isGroup) {
        const senderId = message.senderCharacterId;
        if (!senderId) continue;
        const sender = characterById.get(senderId);
        characterId = senderId;
        characterName = sender?.name || message.senderName || "角色";
        characterAvatar = sender?.avatar || undefined;
      }
      if (!characterId) continue;

      await pushImage({
        sourceId: message.id,
        characterId,
        characterName,
        characterAvatar,
        sessionId: session.id,
        text: message.mediaData?.label?.trim() || message.content?.trim() || "",
        mediaUrl: messageImageRef(message) || "",
        createdAt: message.createdAt,
      });
    }

    // ── 朋友圈 ──
    for (const post of posts) {
      if (added >= ARCHIVE_IMAGE_LIMIT) break;
      if (post.authorType !== "character" || !post.photoUrl) continue;
      if (post.photoGenerationStatus === "pending" || post.photoGenerationStatus === "failed") continue;
      const character = characterById.get(post.authorId);
      await pushImage({
        sourceId: `moment_${post.id}`,
        characterId: post.authorId,
        characterName: character?.name || "角色",
        characterAvatar: character?.avatar || undefined,
        text: post.photoDescription?.trim() || post.content?.trim() || "",
        mediaUrl: post.photoUrl,
        createdAt: post.createdAt,
      });
    }

    if (changed) saveStore(store);
    return added;
  } catch {
    return 0;
  }
}
