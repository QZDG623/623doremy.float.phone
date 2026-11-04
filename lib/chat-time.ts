function padTwo(n: number): string {
    return n < 10 ? `0${n}` : `${n}`;
}

export function formatChatUiTime(dateStr: string): string {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "";

    const hhmm = `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;
    // 统一显示完整日期：今天/昨天/星期几的简写会让人（和模型）误判时间跨度，
    // 这里一律用「某年某月某日 某时:某分」。
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
}
