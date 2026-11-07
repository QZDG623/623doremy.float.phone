// lib/chat-db.ts
// IndexedDB persistence layer for chat data using Dexie.js.
// Provides async persistence behind the synchronous in-memory cache in chat-storage.ts.

import Dexie from "dexie";
import type { ChatMessage, ChatSession, ChatContact } from "./chat-storage";

// 快照：整份聊天数据的一天一次副本。主表被系统逐出/写入中断/读取失败时，
// 还能从快照把「最近一天的完整状态」捞回来，而不是面对一个空库。
export type ChatSnapshot = {
    id: string;
    createdAt: string;
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
};

export type ChatDbInitResult = {
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
    /** 主表为空时从快照恢复过 */
    recoveredFromSnapshot?: boolean;
    snapshotAt?: string;
    /** 上次进程没有正常退出（通常是卡死后被系统杀掉） */
    uncleanExit?: boolean;
};

// ── Database Schema ──────────────────────────────

class ChatDatabase extends Dexie {
    messages!: Dexie.Table<ChatMessage, string>;
    sessions!: Dexie.Table<ChatSession, string>;
    contacts!: Dexie.Table<ChatContact, string>;
    snapshots!: Dexie.Table<ChatSnapshot, string>;

    constructor() {
        super("AiPhoneChatDB");
        this.version(1).stores({
            messages: "id, sessionId, createdAt",
            sessions: "id, contactId",
            contacts: "id, characterId",
        });
        // v2：新增 snapshots 表。只加表，不动既有三张表，升级是原地加法。
        this.version(2).stores({
            messages: "id, sessionId, createdAt",
            sessions: "id, contactId",
            contacts: "id, characterId",
            snapshots: "id, createdAt",
        });
    }
}

export const chatDb = new ChatDatabase();

// ── Initialization + Migration from localStorage ──

const LS_MESSAGES_KEY = "ai_phone_chat_messages_v1";
const LS_SESSIONS_KEY = "ai_phone_chat_sessions_v1";
const LS_CONTACTS_KEY = "ai_phone_chat_contacts_v1";
const LS_MIGRATED_FLAG = "ai_phone_idb_migrated_v1";

/**
 * Initialize IndexedDB and migrate data from localStorage if needed.
 * Returns the loaded data for the in-memory caches.
 */
async function loadChatDbData(): Promise<ChatDbInitResult> {
    if (typeof window === "undefined") {
        return { messages: [], sessions: [], contacts: [] };
    }

    const alreadyMigrated = window.localStorage.getItem(LS_MIGRATED_FLAG);

    if (!alreadyMigrated) {
        // ── 防误清防线 ──────────────────────────────────────────
        // 迁移标记在易失的 localStorage，真实数据在更持久的 IndexedDB。标记可能
        // 单独消失（清「缓存」、隐私工具、配额逐出）。这里任何一步出错（包括
        // localStorage 配额满导致 setItem 抛错）都绝不允许落入下方「全新安装」的
        // 迁移分支——那个分支会把空的 localStorage 当成真数据返回并删掉旧键，
        // 水合后的第一次全量保存（dbReplaceSessions = clear + put）就会把
        // IndexedDB 里的真实会话/联系人整表清掉，也就是「小手机全部变成初始
        // 状态」的事故。
        let indexedDbHasData = false;
        try {
            const existingCount =
                (await chatDb.messages.count()) +
                (await chatDb.sessions.count()) +
                (await chatDb.contacts.count());
            indexedDbHasData = existingCount > 0;
        } catch (err) {
            // 探测失败（被占用/配额/瞬时错误）≠ 空库：改走带重试的 IndexedDB
            // 直读；仍失败就抛错保持「未水合」状态——所有写路径会自动退化为
            // 只增不改（见 chat-storage.ts），宁可见空也不能用空数据覆盖真库。
            console.warn("[ChatDB] Pre-migration IndexedDB check failed; recovering directly:", err);
            const recovered = await loadFromIndexedDbWithRetries();
            if (recovered) {
                markMigrated();
                return recovered;
            }
            throw new Error(`[ChatDB] 无法读取本地聊天数据库（${
                err instanceof Error ? err.message : String(err)
            }），已保持未水合状态以避免覆盖真实数据`);
        }

        if (indexedDbHasData) {
            const [messages, sessions, contacts] = await Promise.all([
                chatDb.messages.toArray(),
                chatDb.sessions.toArray(),
                chatDb.contacts.toArray(),
            ]);
            // 标记写失败（localStorage 配额满）只是性能问题，绝不能连带
            // 丢弃已读出的 IndexedDB 数据。
            markMigrated();
            console.log(`[ChatDB] Migration flag missing but IndexedDB has data; reusing it: ${messages.length} messages, ${sessions.length} sessions, ${contacts.length} contacts`);
            return { messages, sessions, contacts };
        }

        // First run after migration: move localStorage data → IndexedDB
        try {
            const rawMessages = window.localStorage.getItem(LS_MESSAGES_KEY);
            const rawSessions = window.localStorage.getItem(LS_SESSIONS_KEY);
            const rawContacts = window.localStorage.getItem(LS_CONTACTS_KEY);

            const lsMessages: ChatMessage[] = rawMessages ? JSON.parse(rawMessages) : [];
            const lsSessions: ChatSession[] = rawSessions ? JSON.parse(rawSessions) : [];
            const lsContacts: ChatContact[] = rawContacts ? JSON.parse(rawContacts) : [];

            if (lsMessages.length > 0) {
                await chatDb.messages.bulkPut(lsMessages);
            }
            if (lsSessions.length > 0) {
                await chatDb.sessions.bulkPut(lsSessions);
            }
            if (lsContacts.length > 0) {
                await chatDb.contacts.bulkPut(lsContacts);
            }

            // Mark as migrated and remove old localStorage data
            window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
            window.localStorage.removeItem(LS_MESSAGES_KEY);
            window.localStorage.removeItem(LS_SESSIONS_KEY);
            window.localStorage.removeItem(LS_CONTACTS_KEY);

            console.log(`[ChatDB] Migrated from localStorage: ${lsMessages.length} messages, ${lsSessions.length} sessions, ${lsContacts.length} contacts`);

            return { messages: lsMessages, sessions: lsSessions, contacts: lsContacts };
        } catch (err) {
            console.error("[ChatDB] Migration failed, falling back to localStorage:", err);
            // If migration fails, load from localStorage as fallback
            const fallbackMessages: ChatMessage[] = safeParse(window.localStorage.getItem(LS_MESSAGES_KEY));
            const fallbackSessions: ChatSession[] = safeParse(window.localStorage.getItem(LS_SESSIONS_KEY));
            const fallbackContacts: ChatContact[] = safeParse(window.localStorage.getItem(LS_CONTACTS_KEY));
            return { messages: fallbackMessages, sessions: fallbackSessions, contacts: fallbackContacts };
        }
    }

    // Already migrated: load from IndexedDB (with retries)
    const loaded = await loadFromIndexedDbWithRetries();
    if (!loaded) {
        throw new Error("[ChatDB] Failed to load after 3 attempts");
    }
    return loaded;
}

/** 写迁移标记；失败（如 localStorage 配额满）只是性能问题，不应升级成数据事故。 */
function markMigrated(): void {
    try {
        window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
    } catch (err) {
        console.warn("[ChatDB] Failed to persist migration flag:", err);
    }
}

/** 从 IndexedDB 读取全部数据，失败重试最多 3 次；全部失败返回 null（由调用方决定是否抛错）。 */
async function loadFromIndexedDbWithRetries(): Promise<{
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
} | null> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const [messages, sessions, contacts] = await Promise.all([
                chatDb.messages.toArray(),
                chatDb.sessions.toArray(),
                chatDb.contacts.toArray(),
            ]);
            console.log(`[ChatDB] Loaded from IndexedDB: ${messages.length} messages, ${sessions.length} sessions, ${contacts.length} contacts`);
            return { messages, sessions, contacts };
        } catch (err) {
            lastErr = err;
            console.warn(`[ChatDB] Load attempt ${attempt + 1}/3 failed:`, err);
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
                try { if (!chatDb.isOpen()) await chatDb.open(); } catch {}
            }
        }
    }
    console.error("[ChatDB] All load attempts failed:", lastErr);
    return null;
}

function safeParse<T>(raw: string | null): T[] {
    try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ── Async persistence helpers (fire-and-forget) ──

export function dbPutMessage(msg: ChatMessage): void {
    touchChatHeartbeat();
    chatDb.messages.put(msg).catch(err => console.warn("[ChatDB] put message failed:", err));
}

export function dbPutMessages(msgs: ChatMessage[]): void {
    touchChatHeartbeat();
    chatDb.messages.bulkPut(msgs).catch(err => console.warn("[ChatDB] bulkPut messages failed:", err));
}

// 可等待、错误上抛、分块提交的批量写入。导入聊天记录这类大批量落库必须
// 感知真实结果（配额满/写入失败要能反馈给用户），且分块避免巨型单事务
// 卡死主线程；每块之间自然让出事件循环，页面保持可响应。
const DB_BULK_PUT_CHUNK = 2000;
export async function dbBulkPutMessages(msgs: ChatMessage[]): Promise<void> {
    if (msgs.length === 0) return;
    for (let start = 0; start < msgs.length; start += DB_BULK_PUT_CHUNK) {
        await chatDb.messages.bulkPut(msgs.slice(start, start + DB_BULK_PUT_CHUNK));
    }
}

export function dbDeleteMessage(id: string): void {
    chatDb.messages.delete(id).catch(err => console.warn("[ChatDB] delete message failed:", err));
}

export function dbDeleteMessagesBySession(sessionId: string): void {
    chatDb.messages.where("sessionId").equals(sessionId).delete()
        .then(async () => {
            // 删完最后一个会话的消息 = 用户主动清空，之后不再从快照复活。
            if ((await chatDb.sessions.count()) === 0 && (await chatDb.messages.count()) === 0) markEmptied();
        })
        .catch(err => console.warn("[ChatDB] delete session messages failed:", err));
}

export function dbDeleteMessagesByIds(ids: string[]): void {
    chatDb.messages.bulkDelete(ids).catch(err => console.warn("[ChatDB] bulkDelete messages failed:", err));
}

export function dbPutSession(session: ChatSession): void {
    chatDb.sessions.put(session).catch(err => console.warn("[ChatDB] put session failed:", err));
}

export function dbPutSessions(sessions: ChatSession[]): void {
    chatDb.sessions.bulkPut(sessions).catch(err => console.warn("[ChatDB] bulkPut sessions failed:", err));
}

export function dbReplaceSessions(sessions: ChatSession[]): void {
    chatDb.transaction("rw", chatDb.sessions, async () => {
        await chatDb.sessions.clear();
        await chatDb.sessions.bulkPut(sessions);
    }).catch(err => console.warn("[ChatDB] replace sessions failed:", err));
    if (sessions.length === 0) markEmptied();
}

export function dbDeleteSession(id: string): void {
    chatDb.sessions.delete(id).catch(err => console.warn("[ChatDB] delete session failed:", err));
}

export function dbPutContacts(contacts: ChatContact[]): void {
    chatDb.contacts.bulkPut(contacts).catch(err => console.warn("[ChatDB] bulkPut contacts failed:", err));
}

export function dbClearContacts(): void {
    chatDb.contacts.clear().catch(err => console.warn("[ChatDB] clear contacts failed:", err));
}

export function dbReplaceContacts(contacts: ChatContact[]): void {
    chatDb.transaction("rw", chatDb.contacts, async () => {
        await chatDb.contacts.clear();
        await chatDb.contacts.bulkPut(contacts);
    }).catch(err => console.warn("[ChatDB] replaceContacts failed:", err));
}

// ── 每日快照 / 异常退出检测 ──────────────────────────
//
// 逐出与崩溃是 WebView 的常态：IndexedDB 可能被系统回收，进程也可能被 OOM 杀掉。
// 这两件事都不是「用户的错」，但都会让下一次启动看起来像「数据全没了」。
// 因此这里做两件事：
//   1. 每天留一份完整快照（保留最近 7 份），主表为空时优先从快照恢复；
//   2. 用心跳 + 退出标记区分「正常退出」和「被系统杀掉」，后者会提示用户，
//      而不是默默展示一个空聊天列表。
// 唯一例外：用户自己清空过（tombstone 之后）不恢复，避免删空后又被快照复活。

const SNAPSHOT_KEEP = 7;
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LS_HEARTBEAT_KEY = "ai_phone_chat_heartbeat_v1";
const LS_CLEAN_EXIT_KEY = "ai_phone_chat_clean_exit_v1";
const LS_EMPTIED_AT_KEY = "ai_phone_chat_emptied_at_v1";
const UNCLEAN_WINDOW_MS = 30 * 60 * 1000;
const HEARTBEAT_THROTTLE_MS = 30 * 1000;

let _lastHeartbeatWrite = 0;
let _exitTrackingInstalled = false;

/** 记录一次「我还活着」。节流写入，供下次启动判断上次是否正常退出。 */
export function touchChatHeartbeat(): void {
    if (typeof window === "undefined") return;
    const now = Date.now();
    if (now - _lastHeartbeatWrite < HEARTBEAT_THROTTLE_MS) return;
    _lastHeartbeatWrite = now;
    try { window.localStorage.setItem(LS_HEARTBEAT_KEY, String(now)); } catch {}
}

/** 用户主动清空数据的时间点：早于它的快照不再自动恢复。 */
function markEmptied(): void {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(LS_EMPTIED_AT_KEY, String(Date.now())); } catch {}
}

function readEmptiedAt(): number {
    if (typeof window === "undefined") return 0;
    try { return Number(window.localStorage.getItem(LS_EMPTIED_AT_KEY) || "0") || 0; } catch { return 0; }
}

/** 启动时调用：返回上次是否属于异常退出，并重置本轮心跳/退出标记。 */
function markSessionStarted(): boolean {
    if (typeof window === "undefined") return false;
    try {
        const clean = window.localStorage.getItem(LS_CLEAN_EXIT_KEY) === "1";
        const last = Number(window.localStorage.getItem(LS_HEARTBEAT_KEY) || "0");
        const unclean = !clean && last > 0 && Date.now() - last < UNCLEAN_WINDOW_MS;
        window.localStorage.setItem(LS_CLEAN_EXIT_KEY, "0");
        window.localStorage.setItem(LS_HEARTBEAT_KEY, String(Date.now()));
        return unclean;
    } catch {
        return false;
    }
}

function markCleanExit(): void {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(LS_CLEAN_EXIT_KEY, "1"); } catch {}
}

function installExitTracking(): void {
    if (_exitTrackingInstalled || typeof window === "undefined") return;
    _exitTrackingInstalled = true;
    window.addEventListener("pagehide", markCleanExit);
    window.addEventListener("beforeunload", markCleanExit);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden") return;
        touchChatHeartbeat();
        // 切后台时补一次快照：这是最可能在进程被杀之前完成的时机。
        void takeChatSnapshot(false);
    });
}

/** 留一份完整快照（默认 24 小时一次）。空库不写，避免覆盖有价值的旧快照。 */
export async function takeChatSnapshot(force = false): Promise<void> {
    try {
        const latest = await chatDb.snapshots.orderBy("createdAt").last();
        if (!force && latest && Date.now() - new Date(latest.createdAt).getTime() < SNAPSHOT_INTERVAL_MS) {
            return;
        }
        const [messages, sessions, contacts] = await Promise.all([
            chatDb.messages.toArray(),
            chatDb.sessions.toArray(),
            chatDb.contacts.toArray(),
        ]);
        if (messages.length === 0 && sessions.length === 0) return;
        const createdAt = new Date().toISOString();
        await chatDb.snapshots.put({ id: createdAt, createdAt, messages, sessions, contacts });
        const all = await chatDb.snapshots.orderBy("createdAt").toArray();
        const overflow = all.slice(0, Math.max(0, all.length - SNAPSHOT_KEEP));
        if (overflow.length > 0) {
            await chatDb.snapshots.bulkDelete(overflow.map(s => s.id));
        }
    } catch (err) {
        console.warn("[ChatDB] take snapshot failed:", err);
    }
}

export async function readLatestChatSnapshot(): Promise<ChatSnapshot | null> {
    try {
        return (await chatDb.snapshots.orderBy("createdAt").last()) || null;
    } catch {
        return null;
    }
}

/** 主表完全为空时，从最近一份快照恢复。返回 null 表示没有可用快照。 */
async function restoreFromSnapshot(): Promise<ChatDbInitResult | null> {
    const snap = await readLatestChatSnapshot();
    if (!snap) return null;
    if (snap.messages.length === 0 && snap.sessions.length === 0) return null;
    // 用户自己清空过：比清空更早的快照不恢复，避免「删空了又被复活」。
    const emptiedAt = readEmptiedAt();
    if (emptiedAt > 0 && new Date(snap.createdAt).getTime() <= emptiedAt) return null;
    await chatDb.transaction("rw", chatDb.messages, chatDb.sessions, chatDb.contacts, async () => {
        await chatDb.messages.bulkPut(snap.messages);
        await chatDb.sessions.bulkPut(snap.sessions);
        await chatDb.contacts.bulkPut(snap.contacts);
    });
    console.warn(`[ChatDB] Main tables were empty; restored snapshot ${snap.createdAt} (${snap.messages.length} messages)`);
    return {
        messages: snap.messages,
        sessions: snap.sessions,
        contacts: snap.contacts,
        recoveredFromSnapshot: true,
        snapshotAt: snap.createdAt,
    };
}

/**
 * 对外入口：读库 → 空库时尝试快照恢复 → 成功读到数据就安排当日快照。
 * 注意它**不会**吞掉读取失败（由 chat-storage 显式报错），否则会退化成「静默空库」。
 */
export async function initChatDb(): Promise<ChatDbInitResult> {
    installExitTracking();
    const uncleanExit = markSessionStarted();
    const data = await loadChatDbData();
    const empty = data.messages.length === 0 && data.sessions.length === 0 && data.contacts.length === 0;
    if (empty) {
        const restored = await restoreFromSnapshot();
        if (restored) return { ...restored, uncleanExit };
        return { ...data, uncleanExit };
    }
    // 启动快照延后几秒：避免在刚打开 App、其它 store 还在水合时再复制一份大数组，
    // 把启动阶段的内存峰值顶到系统 OOM 阈值。
    setTimeout(() => { void takeChatSnapshot(false); }, 5000);
    return { ...data, uncleanExit };
}
