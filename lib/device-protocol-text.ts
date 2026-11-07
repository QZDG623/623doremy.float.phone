// 设备动作的「文本协议」清洗。
//
// 有些模型不会按 [执行动作:...] 调用，而是把参数原样吐成文本：
//   action: torch
//   on: true
// 这些行是协议，不是台词。放在独立模块里，让富文本解析（历史消息渲染）
// 也能用同一套规则，而不必依赖整个工具执行器。

export const DEVICE_ACTION_VALUES = new Set([
    "torch", "volume", "brightness", "dnd", "openApp",
    "alarm", "timer", "media", "openUrl",
]);

/** 设备动作协议里允许出现的键。只在 action 行确实是设备动作时才据此删行，
 *  避免把角色台词里正常的「xx：yy」误删。 */
const DEVICE_PROTOCOL_KEYS = new Set([
    "action", "on", "level", "mode", "stream",
    "hour", "minute", "minutes", "seconds",
    "app", "url", "device", "direction", "query", "message", "title",
]);

/** 把模型吐出来的设备动作参数行（YAML / 键值）从正文里剔掉——这些是协议，不是台词。
 *  整段都是协议时返回空串，调用方据此丢弃这条气泡。 */
export function stripDeviceProtocolLines(text: string): string {
    if (!text) return text;
    const lines = text.split(/\r?\n/);
    const protocolLineSet = new Set<string>();
    for (const line of lines) {
        const match = line.trim().match(/^[-*]?\s*([A-Za-z][A-Za-z0-9_]*)\s*[:：]\s*(.*)$/);
        if (match && DEVICE_PROTOCOL_KEYS.has(match[1])) protocolLineSet.add(line);
    }
    if (protocolLineSet.size === 0) return text;

    const actionLine = [...protocolLineSet].find(line => /^[-*]?\s*action\s*[:：]/i.test(line.trim()));
    if (!actionLine) {
        // 没有 action 的孤立参数行（"on: true"、"level: 40"）单独出现时无法构成动作；
        // 整段只有这些行就整条丢掉，混着正常台词则保持原样。
        const remaining = lines.filter(line => line.trim() && !protocolLineSet.has(line));
        return remaining.length === 0 ? "" : text;
    }

    const actionValue = actionLine
        .replace(/^[-*]?\s*action\s*[:：]\s*/i, "")
        .replace(/^["'`]|["'`]$/g, "")
        .trim();
    if (!DEVICE_ACTION_VALUES.has(actionValue)) return text;

    return lines
        .filter(line => !protocolLineSet.has(line))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
