// lib/stt-cloud.ts — 云端语音识别（按住说话）
//
// 非 iOS 设备的通话不再依赖浏览器 Web Speech API（国内安卓基本不可用，且持续
// 开麦会把整页音频会话钉在通话模式）。改为微信式按住说话：按住用 MediaRecorder
// 录一段音，松手后发给 OpenAI 兼容的 /audio/transcriptions 转文字。麦克风只在
// 按住的几秒内打开，松手立刻释放，不再有音频会话残留问题。
// iOS 保持原有 Web Speech 免提方案（见 tts-service.ts 的会话说明）。

import { loadBindingConfig, loadVoiceConfigs, resolveBinding } from "./settings-storage";
import type { VoiceApiConfig } from "./settings-types";

export type CloudSttConfig = {
    provider: "OpenAI" | "Minimax";
    baseUrl: string;
    apiKey: string;
    model: string;
};

const DEFAULT_STT_MODEL = "whisper-1";
const DEFAULT_MINIMAX_STT_MODEL = "asr-1.0";
const TRANSCRIBE_TIMEOUT_MS = 60_000;
// 录音兜底上限：忘记松手/指针事件丢失时自动停，避免无限占用麦克风
const MAX_RECORDING_MS = 60_000;

function toCloudSttConfig(config: VoiceApiConfig | undefined | null): CloudSttConfig | null {
    if (!config) return null;
    if (config.provider !== "OpenAI" && config.provider !== "Minimax") return null;
    if (!config.apiKey?.trim()) return null;
    if (config.enableSTT === false) return null;

    const baseUrl = (config.baseUrl || "").trim().replace(/\/+$/, "");
    const apiKey = config.apiKey.trim();

    if (config.provider === "Minimax") {
        return {
            provider: "Minimax",
            baseUrl: baseUrl || "https://api.minimaxi.com/v1",
            apiKey,
            model: config.sttModel?.trim() || DEFAULT_MINIMAX_STT_MODEL,
        };
    }

    return {
        provider: "OpenAI",
        baseUrl: baseUrl || "https://api.openai.com/v1",
        apiKey,
        model: config.sttModel?.trim() || DEFAULT_STT_MODEL,
    };
}

/**
 * 解析可用的云端识别配置：优先角色绑定的语音配置（须为 OpenAI / MiniMax 且启用 STT），
 * 否则取第一个满足条件的语音配置。没有则返回 null（通话回落到文字输入）。
 */
export function resolveCloudSttConfig(characterId?: string): CloudSttConfig | null {
    const configs = loadVoiceConfigs();
    if (characterId) {
        const bindings = loadBindingConfig();
        const slot = resolveBinding(bindings, characterId, "chat");
        const bound = configs.find(c => c.id === slot.voiceConfigId);
        const fromBound = toCloudSttConfig(bound);
        if (fromBound) return fromBound;
    }
    for (const config of configs) {
        const cloud = toCloudSttConfig(config);
        if (cloud) return cloud;
    }
    return null;
}

export function isCallRecordingSupported(): boolean {
    return typeof navigator !== "undefined"
        && !!navigator.mediaDevices?.getUserMedia
        && typeof MediaRecorder !== "undefined";
}

export type ActiveCallRecording = {
    /** 松手：停止录音并返回音频（没录到内容返回 null）。 */
    stop: () => Promise<Blob | null>;
    /** 取消：丢弃已录内容，立即释放麦克风。 */
    cancel: () => void;
};

/** 按下开始录音。resolve 时麦克风已经在录；权限被拒等失败会 reject。 */
export async function startCallRecording(): Promise<ActiveCallRecording> {
    if (!isCallRecordingSupported()) throw new Error("当前环境不支持录音");

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
        throw new Error("麦克风权限被拒绝或不可用");
    });

    // 优先 mp4(aac)：OpenAI whisper 与 MiniMax asr-1.0 都支持；
    // webm(opus) 仅 OpenAI 认，MiniMax 不认 webm 容器。
    const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"]
        .find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
    const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 })
        : new MediaRecorder(stream);

    const chunks: Blob[] = [];
    let finished = false;
    let cancelled = false;
    let resolveStop: ((blob: Blob | null) => void) | null = null;

    const releaseMic = () => {
        try { stream.getTracks().forEach(track => track.stop()); } catch { /* ignore */ }
    };

    recorder.ondataavailable = event => {
        if (event.data && event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(maxTimer);
        releaseMic();
        if (cancelled) { resolveStop?.(null); return; }
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        resolveStop?.(blob.size > 0 ? blob : null);
    };
    recorder.onerror = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(maxTimer);
        releaseMic();
        resolveStop?.(null);
    };

    const maxTimer = window.setTimeout(() => {
        try { recorder.stop(); } catch { /* ignore */ }
    }, MAX_RECORDING_MS);

    recorder.start();

    return {
        stop: () => new Promise<Blob | null>(resolve => {
            resolveStop = resolve;
            if (finished) { resolve(null); return; }
            try { recorder.stop(); } catch { recorder.onstop?.(new Event("stop") as never); }
        }),
        cancel: () => {
            cancelled = true;
            if (finished) return;
            try { recorder.stop(); } catch {
                finished = true;
                window.clearTimeout(maxTimer);
                releaseMic();
            }
        },
    };
}

// ── 连续监听（免提通话）────────────────────────────────
//
// 非 iOS 的通话里，原先只有「按住说话」——按一下录一段、松手才识别。用户要的是
// 真·电话那种：进了语音模式就一直听，说完一句自动识别发出去。这里实现一个
// 基于音量（RMS）的语音活动检测（VAD）：
//   - 麦克风常开，AnalyserNode 实时算 RMS；
//   - 音量超过阈值 → 判定为开始说话，启动 MediaRecorder 录这一段；
//   - 音量掉到阈值以下并持续 silenceMs → 判定一句话说完，停录、把这段音频
//     回调出去给上层转写；
//   - 回到「待命」，继续等下一句。
//
// 这样一句一句地切，每段几秒到十几秒，转写接口压力小、延迟也低。静音期间不
// 录音，麦克风虽然开着但不产生数据。

export type ContinuousVoiceCallbacks = {
    /** 检测到开口（音量越过阈值） */
    onSpeechStart?: () => void;
    /** 一句话说完，回调这段音频 */
    onSegment: (blob: Blob) => void;
    /** 出错（麦克风权限、录音失败等） */
    onError: (message: string) => void;
    /** 实时音量 0~1，UI 可用来做波形/动效 */
    onLevel?: (level: number) => void;
};

export type ContinuousVoiceSession = {
    /** 彻底停止，释放麦克风 */
    stop: () => void;
    /** 静音/取消静音：静音时不录音也不切段，但麦克风保持打开 */
    setMuted: (muted: boolean) => void;
};

const DEFAULT_VAD = {
    levelThreshold: 0.012,   // RMS 阈值下限（实际阈值还会按环境噪声自适应抬高）
    minSpeechMs: 350,        // 短于此视为误触丢弃
    silenceMs: 800,          // 停顿多久算一句说完
    attackFrames: 3,         // 连续几帧超阈值才算开口（抗爆音）
};

/** 申请麦克风：优先带回声消除/降噪；个别 WebView 不接受对象参数时退回 audio:true */
async function openMic(): Promise<MediaStream> {
    const want = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
    };
    try {
        return await navigator.mediaDevices.getUserMedia({ audio: want });
    } catch {
        return await navigator.mediaDevices.getUserMedia({ audio: true })
            .catch(() => { throw new Error("麦克风权限被拒绝或不可用"); });
    }
}

export async function startContinuousVoice(
    callbacks: ContinuousVoiceCallbacks,
    vad: Partial<typeof DEFAULT_VAD> = {},
): Promise<ContinuousVoiceSession> {
    if (!isCallRecordingSupported()) throw new Error("当前环境不支持录音");
    const cfg = { ...DEFAULT_VAD, ...vad };

    const stream = await openMic();

    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    const audioCtx: AudioContext = new AudioCtx();
    // 关键：安卓 WebView 里新建的 AudioContext 常是 suspended，AnalyserNode 会一直
    // 返回静音波形（全 128）→ RMS 恒为 0 → VAD 永远不触发、一句话也录不到。
    // 必须显式 resume，并在前几秒持续兜底（个别机型要等音频焦点释放才可恢复）。
    const ensureRunning = () => {
        if (audioCtx.state === "suspended") void audioCtx.resume().catch(() => {});
    };
    ensureRunning();
    const resumeTimer = window.setInterval(ensureRunning, 400);
    const stopResumeTimer = window.setTimeout(() => window.clearInterval(resumeTimer), 6000);
    // 页面首次触摸也尝试恢复（部分 WebView 要求 resume 发生在用户手势里）
    window.addEventListener("pointerdown", ensureRunning, true);

    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);
    const timeData = new Uint8Array(analyser.fftSize);

    const pickMime = () =>
        ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"]
            .find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });

    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let recStartTs = 0;
    let muted = false;
    let stopped = false;
    let state: "idle" | "speaking" = "idle";
    let lastSpeechAt = 0;
    let attackCount = 0;
    let rafId = 0;
    // 环境噪声底噪（自适应）：安静时缓慢跟随，阈值取「底噪 × 2.2」与下限的较大值，
    // 避免不同机型麦克风增益差异导致要么一直误触发、要么永远听不到。
    let noiseFloor = 0.004;

    const releaseMic = () => {
        window.clearInterval(resumeTimer);
        window.clearTimeout(stopResumeTimer);
        window.removeEventListener("pointerdown", ensureRunning, true);
        try { stream.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
        try { audioCtx.close().catch(() => {}); } catch { /* ignore */ }
    };

    const startRecorder = () => {
        chunks = [];
        const mime = pickMime();
        try {
            recorder = mime
                ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 })
                : new MediaRecorder(stream);
        } catch {
            recorder = new MediaRecorder(stream);
        }
        recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.onerror = () => {
            recorder = null;
            chunks = [];
            callbacks.onError("录音失败，请重试");
        };
        recorder.start();
        recStartTs = performance.now();
    };

    const flushSegment = () => {
        const r = recorder;
        recorder = null;
        if (!r) return;
        const onstop = () => {
            const blob = new Blob(chunks, { type: r.mimeType || "audio/webm" });
            chunks = [];
            const dur = performance.now() - recStartTs;
            if (blob.size > 0 && dur >= cfg.minSpeechMs) {
                callbacks.onSegment(blob);
            }
        };
        try {
            r.onstop = onstop;
            r.stop();
        } catch {
            onstop();
        }
    };

    const loop = () => {
        if (stopped) return;
        rafId = requestAnimationFrame(loop);
        analyser.getByteTimeDomainData(timeData);
        let sum = 0;
        for (let i = 0; i < timeData.length; i++) {
            const v = (timeData[i] - 128) / 128;
            sum += v * v;
        }
        const rms = Math.sqrt(sum / timeData.length);
        callbacks.onLevel?.(rms);

        if (muted) {
            if (state === "speaking") { state = "idle"; flushSegment(); }
            return;
        }

        const now = performance.now();
        // 自适应阈值：安静时底噪缓慢跟随（只在 idle 且明显低于阈值时更新）
        if (state === "idle" && rms < cfg.levelThreshold) {
            noiseFloor = noiseFloor * 0.98 + rms * 0.02;
        }
        const threshold = Math.max(cfg.levelThreshold, noiseFloor * 2.2);
        const isLoud = rms >= threshold;

        if (state === "idle") {
            if (isLoud) {
                attackCount += 1;
                if (attackCount >= cfg.attackFrames) {
                    attackCount = 0;
                    state = "speaking";
                    lastSpeechAt = now;
                    callbacks.onSpeechStart?.();
                    startRecorder();
                }
            } else {
                attackCount = 0;
            }
        } else {
            if (isLoud) {
                lastSpeechAt = now;
            } else if (now - lastSpeechAt >= cfg.silenceMs) {
                state = "idle";
                flushSegment();
            }
        }
    };

    loop();

    return {
        stop: () => {
            if (stopped) return;
            stopped = true;
            cancelAnimationFrame(rafId);
            if (state === "speaking") flushSegment();
            releaseMic();
        },
        setMuted: (m: boolean) => { muted = m; },
    };
}

/** 调云端语音识别把录音转文字。OpenAI 走 /audio/transcriptions，MiniMax 走 /speech_to_text。 */
export async function transcribeAudioBlob(blob: Blob, config: CloudSttConfig): Promise<string> {
    const type = (blob.type || "").toLowerCase();
    const isMinimax = config.provider === "Minimax";
    // MiniMax 认 wav/aiff/flac/m4a(mp4 容器)/mp3/aac/opus/ogg，不认 webm 容器；
    // MediaRecorder 产出的 audio/mp4 就是 m4a，扩展名按 m4a 传更稳。
    const ext = type.includes("mp4") ? (isMinimax ? "m4a" : "mp4")
        : type.includes("ogg") ? "ogg"
        : type.includes("wav") ? "wav"
        : type.includes("mp3") ? "mp3"
        : "webm";
    const form = new FormData();
    form.set("model", config.model);
    if (isMinimax) form.set("response_format", "json");
    form.set("file", blob, `speech.${ext}`);

    // MiniMax 用 /speech_to_text，OpenAI 兼容用 /audio/transcriptions
    const endpoint = isMinimax
        ? `${config.baseUrl}/speech_to_text`
        : `${config.baseUrl}/audio/transcriptions`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
        const res = await fetch(endpoint, {
            method: "POST",
            headers: { Authorization: `Bearer ${config.apiKey}` },
            body: form,
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`语音识别 API 错误 ${res.status}: ${text.slice(0, 200)}`);
        }
        const contentType = (res.headers.get("content-type") || "").toLowerCase();
        if (contentType.includes("json")) {
            const data = await res.json() as { text?: unknown };
            return typeof data.text === "string" ? data.text.trim() : "";
        }
        // response_format=text 风格的中转直接回纯文本
        return (await res.text()).trim();
    } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
            throw new Error(`语音识别超时（超过 ${Math.round(TRANSCRIBE_TIMEOUT_MS / 1000)} 秒无响应）`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}
