"use client";

// 通话「免提连续监听」共享逻辑（非 iOS 通话输入方案，三个通话界面共用）。
//
// 与按住说话不同：进了语音模式就一直听，麦克风常开，基于音量（RMS）做语音活动
// 检测（VAD）——开口自动录、停顿自动切段、每段送云端转写后直接发出去，用户不用
// 按任何按钮，像真·电话一样。
//
// 设计要点（踩过的坑）：
//   - 关键状态全部用 ref 镜像：onSegment / onSpeechStart 是底层 RAF 循环里触发的，
//     闭包里读到的 React state 必然是旧值。options 用 optionsRef 转发，每次渲染
//     写最新值，回调里读 optionsRef.current。
//   - 一次只允许一个会话：start() 内有 startingRef / sessionRef 双保险，重复调用
//     直接 return；stop() 幂等。
//   - 静音用 setMuted：保持麦克风常开（取消静音无需重新申请权限、无延迟），只是
//     不录音不切段。muted 同时存 ref，会话启动时把最近一次的静音态灌进去。
//   - 卸载兜底：useEffect 清理里 session.stop() 释放麦克风 + AudioContext。

import { useCallback, useEffect, useRef, useState } from "react";
import {
    resolveCloudSttConfig,
    startContinuousVoice,
    transcribeAudioBlob,
    type ContinuousVoiceSession,
} from "@/lib/stt-cloud";

export type ContinuousVoiceState = "idle" | "listening" | "speaking" | "transcribing";

export type UseContinuousVoiceOptions = {
    /** 用于按角色绑定解析识别配置（群聊可不传，取第一个可用配置） */
    characterId?: string;
    /** 检测到开口（音量越过阈值） */
    onSpeechStart?: () => void;
    /** 一句话说完，进入转写阶段 */
    onTranscribeStart?: () => void;
    /** 转写成功，text 非空 */
    onTranscript: (text: string) => void;
    /** 录音 / 转写失败。UI 应回到待命态 */
    onError?: (message: string) => void;
};

export type UseContinuousVoiceHandle = {
    state: ContinuousVoiceState;
    /** 实时音量 0~1，可做波形动效 */
    level: number;
    error: string;
    /** 启动连续监听（麦克风常开 + VAD）。已启动时幂等。 */
    start: () => void;
    /** 停止连续监听，释放麦克风 */
    stop: () => void;
    /** 静音 / 取消静音：静音时不录音不切段，麦克风保持打开 */
    setMuted: (muted: boolean) => void;
};

export function useContinuousVoice(options: UseContinuousVoiceOptions): UseContinuousVoiceHandle {
    const [state, setState] = useState<ContinuousVoiceState>("idle");
    const [level, setLevel] = useState(0);
    const [error, setError] = useState("");

    const sessionRef = useRef<ContinuousVoiceSession | null>(null);
    const startingRef = useRef(false);
    const mountedRef = useRef(true);
    const mutedRef = useRef(false);
    const optionsRef = useRef(options);
    optionsRef.current = options;

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            sessionRef.current?.stop();
            sessionRef.current = null;
        };
    }, []);

    const fail = useCallback((message: string) => {
        if (!mountedRef.current) return;
        setError(message);
        optionsRef.current.onError?.(message);
    }, []);

    const start = useCallback(async () => {
        if (sessionRef.current || startingRef.current) return;
        startingRef.current = true;
        setError("");
        try {
            const session = await startContinuousVoice({
                onSpeechStart: () => {
                    if (!mountedRef.current) return;
                    setState("speaking");
                    optionsRef.current.onSpeechStart?.();
                },
                onSegment: async (blob) => {
                    if (!mountedRef.current) return;
                    setState("transcribing");
                    optionsRef.current.onTranscribeStart?.();
                    try {
                        const config = resolveCloudSttConfig(optionsRef.current.characterId);
                        if (!config) { fail("未找到可用的语音识别配置"); return; }
                        const text = await transcribeAudioBlob(blob, config);
                        if (!mountedRef.current) return;
                        if (text.trim()) {
                            setError("");
                            optionsRef.current.onTranscript(text.trim());
                        }
                    } catch (e) {
                        fail(e instanceof Error ? e.message : String(e));
                    } finally {
                        // 转写完成后回到聆听态（如果会话还活着）。
                        // 会话可能因为切到文字模式 / 挂断 / AI 说话被 stop 掉了，
                        // 这时不要再把状态拉回 listening。
                        if (mountedRef.current && sessionRef.current) {
                            setState("listening");
                        }
                    }
                },
                onError: (message) => {
                    fail(message);
                },
                onLevel: (lvl) => {
                    if (mountedRef.current) setLevel(lvl);
                },
            });
            startingRef.current = false;
            if (!mountedRef.current) { session.stop(); return; }
            sessionRef.current = session;
            // 把最近一次的静音态灌进去（启动期间可能被改过）
            session.setMuted(mutedRef.current);
            setState("listening");
        } catch (e) {
            startingRef.current = false;
            fail(e instanceof Error ? e.message : String(e));
            setState("idle");
        }
    }, [fail]);

    const stop = useCallback(() => {
        if (sessionRef.current) {
            sessionRef.current.stop();
            sessionRef.current = null;
        }
        if (mountedRef.current) {
            setState("idle");
            setLevel(0);
        }
    }, []);

    const setMuted = useCallback((muted: boolean) => {
        mutedRef.current = muted;
        sessionRef.current?.setMuted(muted);
    }, []);

    return { state, level, error, start, stop, setMuted };
}
