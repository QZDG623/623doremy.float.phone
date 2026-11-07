"use client";

// 小手机角色聊天的输入栏。
//
// 为什么单独拆出来：输入文字的状态原先挂在 MascotChatRoom 顶层，每按一个键都会让
// 1200+ 行的整个聊天页（消息列表、气泡、各种 hook）全量重渲染，消息越多越卡。
// 现在文本状态只存在于本组件内，打字只重渲染这一条输入栏；父组件只在真正
// 发送/切换表情面板时才收到回调。
//
// 约定：onSubmit 返回 true 表示「已受理」，本组件才会清空输入框（思考中按回车
// 走停止分支，不清空，保持原行为）。

import { memo, useCallback, useRef, useState } from "react";
import { Image as ImageIcon, Sparkles } from "lucide-react";

import { EmojiPanel } from "./emoji-panel";
import { shouldSendChatInputOnEnter } from "@/lib/chat-input-keyboard";

export type MascotComposerProps = {
    isThinking: boolean;
    pendingImages: string[];
    imagePreviewCache: Record<string, string>;
    enterToSendEnabled: boolean;
    emojiOpen: boolean;
    onEmojiOpenChange: (open: boolean) => void;
    onPickImages: (files: File[]) => void;
    onRemovePendingImage: (index: number) => void;
    /** 返回 true 表示消息已受理，输入框会被清空 */
    onSubmit: (text: string) => boolean;
    onStop: () => void;
    canGenerateReply: boolean;
    onGenerateReply: () => void;
    placeholder: string;
};

function MascotComposerImpl({
    isThinking,
    pendingImages,
    imagePreviewCache,
    enterToSendEnabled,
    emojiOpen,
    onEmojiOpenChange,
    onPickImages,
    onRemovePendingImage,
    onSubmit,
    onStop,
    canGenerateReply,
    onGenerateReply,
    placeholder,
}: MascotComposerProps) {
    const [text, setText] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    const resizeTextarea = useCallback(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
    }, []);

    const submit = useCallback(() => {
        if (isThinking) {
            onStop();
            return;
        }
        if (!onSubmit(text)) return;
        setText("");
        textareaRef.current?.style.setProperty("height", "auto");
    }, [isThinking, onStop, onSubmit, text]);

    const appendEmoji = useCallback((emoji: string) => {
        setText((prev) => prev + emoji);
        requestAnimationFrame(() => {
            resizeTextarea();
            textareaRef.current?.focus();
        });
    }, [resizeTextarea]);

    return (
        <div className="chat-input-bar chat-room-main-pane flex flex-col" data-ui="input">
            {pendingImages.length > 0 && (
                <div className="mascot-pending-strip">
                    {pendingImages.map((ref, idx) => {
                        const url = imagePreviewCache[ref];
                        return (
                            <div key={`${ref}-${idx}`} className="mascot-pending-thumb">
                                {url ? <img src={url} alt="" /> : null}
                                <button type="button" onClick={() => onRemovePendingImage(idx)}>×</button>
                            </div>
                        );
                    })}
                </div>
            )}
            <textarea
                ref={textareaRef}
                rows={1}
                value={text}
                onChange={(event) => {
                    setText(event.target.value);
                    resizeTextarea();
                }}
                onFocus={(event) => {
                    if (emojiOpen) {
                        event.target.blur();
                        onEmojiOpenChange(false);
                        const target = event.target;
                        requestAnimationFrame(() => requestAnimationFrame(() => target.focus()));
                    }
                }}
                onKeyDown={(event) => {
                    if (shouldSendChatInputOnEnter(event, enterToSendEnabled)) {
                        event.preventDefault();
                        // 思考中回车吞掉：不发送，也不能落进停止分支误停生成（停止只走按钮）
                        if (isThinking) return;
                        submit();
                    }
                }}
                enterKeyHint={enterToSendEnabled ? "send" : "enter"}
                className="chat-input-textarea"
                placeholder={placeholder}
                /* 思考中不再 disable：禁用聚焦中的元素会强制失焦收键盘且不走正常 blur 事件序列，
                   在 iOS PWA 上与键盘收起的 viewport 复原竞态，偶发把底部输入栏卡在屏幕外
                   （表现为发送后整条输入栏消失，退出重进恢复）。对齐普通聊天室：生成中可继续打字，
                   字留在框里；发送键在思考中仍是停止键。 */
            />
            <div className="chat-input-actions">
                <label
                    className="ui-bare-btn text-[var(--c-text)]"
                    aria-disabled={isThinking || pendingImages.length >= 4}
                    title={pendingImages.length >= 4 ? "最多 4 张图" : "添加图片"}
                    onClick={(event) => {
                        if (isThinking || pendingImages.length >= 4) event.preventDefault();
                    }}
                >
                    <ImageIcon size={24} strokeWidth={1.5} />
                    <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                            const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
                            event.currentTarget.value = "";
                            onPickImages(files);
                        }}
                    />
                </label>
                <button
                    type="button"
                    onClick={() => onEmojiOpenChange(!emojiOpen)}
                    className="ui-bare-btn text-[var(--c-text)]"
                    aria-label="表情"
                >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>
                </button>
                <button
                    type="button"
                    onClick={submit}
                    disabled={!isThinking && !text.trim() && pendingImages.length === 0}
                    className="ui-bare-btn text-[var(--c-text)]"
                    aria-label={isThinking ? "停止生成" : "发送"}
                >
                    {isThinking ? (
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="12" cy="12" r="10" />
                            <rect x="9" y="9" width="6" height="6" rx="1" />
                        </svg>
                    ) : (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
                    )}
                </button>
                <button
                    type="button"
                    onClick={onGenerateReply}
                    disabled={!canGenerateReply}
                    className="ui-bare-btn text-[var(--c-text)]"
                    aria-label="重新生成回复"
                    title="生成回复（发送后未生成或删除回复后使用）"
                >
                    <Sparkles size={24} strokeWidth={1.5} />
                </button>
            </div>
            {emojiOpen && <EmojiPanel onSelect={appendEmoji} />}
        </div>
    );
}

export const MascotComposer = memo(MascotComposerImpl);
