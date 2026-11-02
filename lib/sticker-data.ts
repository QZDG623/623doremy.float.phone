/**
 * Built-in sticker pack data.
 * Each sticker has a name (for AI matching via [表情:name]) and a URL.
 * Built-in packs use emoji as the default display; stickerUrl can point to
 * packaged image assets when a pack provides dedicated files.
 */

import { loadUsableCustomStickers } from "./custom-sticker-storage";

export interface StickerItem {
    name: string;
    emoji: string;     // fallback emoji display
    stickerUrl?: string; // real sticker image path (optional)
}

export const STICKER_PACKS: { name: string; stickers: StickerItem[] }[] = [
    {
        name: "经典表情",
        stickers: [
            { name: "捂脸", emoji: "🤦" },
            { name: "偷笑", emoji: "🤭" },
            { name: "大哭", emoji: "😭" },
            { name: "害羞", emoji: "😊" },
            { name: "发呆", emoji: "😶" },
            { name: "得意", emoji: "😏" },
            { name: "汗", emoji: "😅" },
            { name: "亲亲", emoji: "😘" },
            { name: "爱心", emoji: "❤️" },
            { name: "心碎", emoji: "💔" },
            { name: "抱抱", emoji: "🤗" },
            { name: "叹气", emoji: "😮‍💨" },
            { name: "委屈", emoji: "🥺" },
            { name: "嘿嘿", emoji: "😁" },
            { name: "加油", emoji: "💪" },
            { name: "OK", emoji: "👌" },
            { name: "比心", emoji: "🫰" },
            { name: "鼓掌", emoji: "👏" },
            { name: "拳头", emoji: "✊" },
            { name: "玫瑰", emoji: "🌹" },
            { name: "再见", emoji: "👋" },
            { name: "太阳", emoji: "☀️" },
            { name: "月亮", emoji: "🌙" },
            { name: "蛋糕", emoji: "🎂" },
            { name: "礼物", emoji: "🎁" },
            { name: "咖啡", emoji: "☕" },
            { name: "啤酒", emoji: "🍺" },
            { name: "庆祝", emoji: "🎉" },
            { name: "火", emoji: "🔥" },
            { name: "闪电", emoji: "⚡" },
            { name: "思考", emoji: "🤔" },
            { name: "微笑", emoji: "😊" },
            { name: "笑哭", emoji: "😂" },
            { name: "坏笑", emoji: "😈" },
            { name: "翻白眼", emoji: "🙄" },
            { name: "无语", emoji: "😑" },
            { name: "生气", emoji: "😤" },
            { name: "惊讶", emoji: "😲" },
            { name: "恐惧", emoji: "😨" },
            { name: "撇嘴", emoji: "😒" },
            { name: "色", emoji: "😍" },
            { name: "呲牙", emoji: "😬" },
            { name: "吐舌", emoji: "😛" },
            { name: "尴尬", emoji: "😓" },
            { name: "睡觉", emoji: "😴" },
            { name: "酷", emoji: "😎" },
            { name: "衰", emoji: "😩" },
            { name: "吐", emoji: "🤮" },
            { name: "调皮", emoji: "😜" },
            { name: "大笑", emoji: "😆" },
            { name: "难过", emoji: "😢" },
            { name: "疑问", emoji: "❓" },
            { name: "嘘", emoji: "🤫" },
            { name: "晕", emoji: "😵" },
            { name: "奋斗", emoji: "💪" },
            { name: "可怜", emoji: "🥹" },
            { name: "强", emoji: "👍" },
            { name: "弱", emoji: "👎" },
            { name: "握手", emoji: "🤝" },
            { name: "胜利", emoji: "✌️" },
            { name: "抱拳", emoji: "🙏" },
            { name: "勾引", emoji: "😏" },
            { name: "嘴唇", emoji: "💋" },
            { name: "西瓜", emoji: "🍉" },
            { name: "饭", emoji: "🍚" },
            { name: "猪头", emoji: "🐷" },
            { name: "狗", emoji: "🐶" },
            { name: "猫", emoji: "🐱" },
            { name: "骷髅", emoji: "💀" },
            { name: "鬼", emoji: "👻" },
        ],
    },
];

/**
 * Find a sticker by name (for AI [表情:name] matching).
 * Returns the emoji fallback if no real stickerUrl.
 */
export function findStickerByName(name: string): StickerItem | undefined {
    for (const pack of STICKER_PACKS) {
        const found = pack.stickers.find(s => s.name === name);
        if (found) return found;
    }
    return undefined;
}

/**
 * 校验表情包名称是否可用：内置表情或任一给定角色的自定义表情包中存在该名称。
 * 用于「丢弃角色输出的无效表情包」开关。
 */
export function isKnownStickerLabel(label: string, characterIds: (string | undefined)[]): boolean {
    const name = (label || "").trim();
    if (!name) return false;
    if (findStickerByName(name)) return true;
    for (const cid of characterIds) {
        if (!cid) continue;
        if (loadUsableCustomStickers(cid).some(s => (s.name || "").trim() === name)) return true;
    }
    return false;
}

/** 内置表情（emoji）名称列表，作为自定义表情全部失效时的兜底类别。 */
export function getBuiltinStickerNameList(): string {
    return STICKER_PACKS.flatMap(pack => pack.stickers.map(s => s.name)).join("，");
}

export function getBuiltinStickerExample(): string {
    const first = STICKER_PACKS[0]?.stickers[0];
    return `[表情包:${first?.name || "捂脸"}]`;
}

/**
 * 提示词里可用的表情包名：优先角色名下能真实加载的自定义表情；
 * 一个都没有时退回内置 emoji 表情，避免角色只能反复发加载失败的表情。
 */
export function getStickerPromptNames(characterId: string): string {
    const names = loadUsableCustomStickers(characterId)
        .map(sticker => (sticker.name || "").trim())
        .filter(Boolean);
    if (names.length > 0) return names.join("，");
    return getBuiltinStickerNameList();
}

export function getStickerPromptExample(characterId: string): string {
    const first = loadUsableCustomStickers(characterId).find(sticker => (sticker.name || "").trim());
    return first ? `[表情包:${first.name}]` : getBuiltinStickerExample();
}

/** 把内置 emoji 表情画成图片 data URL，供微信云端助手当图片发送。 */
export function buildBuiltinStickerImageMap(): Record<string, string> {
    if (typeof document === "undefined") return {};
    const map: Record<string, string> = {};
    for (const pack of STICKER_PACKS) {
        for (const sticker of pack.stickers) {
            const canvas = document.createElement("canvas");
            canvas.width = 160;
            canvas.height = 160;
            const ctx = canvas.getContext("2d");
            if (!ctx) continue;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.font = `112px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif`;
            ctx.fillText(sticker.emoji, 80, 84);
            map[sticker.name] = canvas.toDataURL("image/png");
        }
    }
    return map;
}

/**
 * 微信云端跑包要用的表情图片表：有可用自定义表情时沿用它们；
 * 自定义表情全部失效时把内置 emoji 画成图片，保证提示词里给出的表情名都能发出图片。
 */
export function resolveStickerImageMapForCloud(
    characterId: string,
    customMap: Record<string, string>,
): Record<string, string> {
    if (loadUsableCustomStickers(characterId).length > 0) return customMap;
    return buildBuiltinStickerImageMap();
}
