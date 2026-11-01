"use client";

// 睡眠电台：把所有「已经生成出来的角色语音」按角色收进一个像听书 App 的语音库。
//
// 数据来源：
//   · 聊天里的语音条（合成完成后落库在 message.mediaUrl 里，data URL 长期有效）；
//   · 收藏夹里的语音（可能来自通话/剧情/其它 App，已经转存 asset://）。
//
// 只收真的有音频的条目：还没合成或已被清理的语音不占位置，点播放时才去解析
// asset:// / media-store:// 地址，解析不出来给一句明确提示。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  Moon,
  Pause,
  Play,
  Radio,
  SkipBack,
  SkipForward,
  Timer,
} from "lucide-react";

import { chatDb } from "@/lib/chat-db";
import { loadCharacters } from "@/lib/character-storage";
import { loadArchiveEntries } from "@/lib/archive-storage";
import { getChatAudioFromIndexedDB } from "@/lib/chat-asset-storage";
import { isMediaStoreRef, loadMediaObjectUrl } from "@/lib/media-cache-storage";

type RadioTrack = {
  id: string;
  characterId: string;
  characterName: string;
  characterAvatar?: string;
  text: string;
  mediaUrl: string;
  createdAt: string;
};

type RadioGroup = {
  characterId: string;
  characterName: string;
  characterAvatar?: string;
  tracks: RadioTrack[];
};

const TIMER_OPTIONS = [
  { value: 0, label: "定时关" },
  { value: 15, label: "15 分" },
  { value: 30, label: "30 分" },
  { value: 60, label: "60 分" },
  { value: 90, label: "90 分" },
  { value: -1, label: "播完这首" },
];

async function resolvePlayableUrl(raw: string, revokeRef: { current: string }): Promise<string> {
  if (raw.startsWith("asset://")) {
    return (await getChatAudioFromIndexedDB(raw.slice(8))) || "";
  }
  if (isMediaStoreRef(raw)) {
    const objectUrl = await loadMediaObjectUrl(raw);
    if (objectUrl) revokeRef.current = objectUrl;
    return objectUrl || "";
  }
  return raw;
}

async function loadRadioGroups(): Promise<RadioGroup[]> {
  const [messages, sessions] = await Promise.all([
    chatDb.messages.orderBy("createdAt").reverse().limit(4000).toArray(),
    chatDb.sessions.toArray(),
  ]);
  const characters = loadCharacters();
  const sessionById = new Map(sessions.map(session => [session.id, session]));
  const characterById = new Map(characters.map(character => [character.id, character]));
  const groups = new Map<string, RadioGroup>();
  const seen = new Set<string>();

  const pushTrack = (track: RadioTrack) => {
    const key = `${track.characterId}:${track.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    let group = groups.get(track.characterId);
    if (!group) {
      group = {
        characterId: track.characterId,
        characterName: track.characterName,
        characterAvatar: track.characterAvatar,
        tracks: [],
      };
      groups.set(track.characterId, group);
    }
    group.tracks.push(track);
  };

  for (const message of messages) {
    if (message.role !== "assistant" || message.mediaType !== "audio" || !message.mediaUrl) continue;
    const session = sessionById.get(message.sessionId);
    if (!session) continue;
    const characterId = message.senderCharacterId || session.contactId;
    if (!characterId) continue;
    const character = characterById.get(characterId);
    const avatar = character?.avatar && character.avatar !== "none" ? character.avatar : undefined;
    pushTrack({
      id: message.id,
      characterId,
      characterName: character?.name || session.alias || message.senderName || "角色",
      characterAvatar: avatar,
      text: message.mediaData?.label?.trim() || "",
      mediaUrl: message.mediaUrl,
      createdAt: message.createdAt,
    });
  }

  // 收藏夹里的语音（来源 id 就是原消息 id，天然与上面的聊天语音去重）
  for (const entry of loadArchiveEntries()) {
    if (entry.kind !== "voice" || !entry.mediaUrl) continue;
    pushTrack({
      id: entry.sourceId,
      characterId: entry.characterId || "unknown",
      characterName: entry.characterName || "未分组",
      characterAvatar: entry.characterAvatar || undefined,
      text: entry.text?.trim() || "",
      mediaUrl: entry.mediaUrl,
      createdAt: entry.createdAt,
    });
  }

  return [...groups.values()]
    .map(group => ({
      ...group,
      tracks: group.tracks.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }))
    .filter(group => group.tracks.length > 0)
    .sort((a, b) => a.characterName.localeCompare(b.characterName, "zh-Hans-CN"));
}

function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

function excerpt(text: string, max = 42): string {
  const clean = text
    .replace(/\(\s*(?:breath|laughs?|sighs?|sniffs?|gasp|pant|inhale|exhale|chuckle|coughs?|clear-throat|groans?|snorts?|burps?|lip-smacking|humming|hissing|emm|sneezes?)\s*\)/gi, "")
    .replace(/<#[\d.]+#>/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "（语音）";
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function SleepRadioApp({ onClose }: { onClose: () => void }) {
  const [groups, setGroups] = useState<RadioGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [timerMinutes, setTimerMinutes] = useState(0);
  const [timerRemaining, setTimerRemaining] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const revokeRef = useRef("");
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const activeCharacterIdRef = useRef(activeCharacterId);
  activeCharacterIdRef.current = activeCharacterId;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const timerMinutesRef = useRef(timerMinutes);
  timerMinutesRef.current = timerMinutes;
  const playTrackRef = useRef<(track: RadioTrack, auto?: boolean) => Promise<void>>(async () => {});

  const playlist = useMemo(() => {
    if (!activeCharacterId) {
      return groups.flatMap(group => group.tracks.map(track => ({ ...track, characterName: track.characterName })));
    }
    return groups.find(group => group.characterId === activeCharacterId)?.tracks || [];
  }, [groups, activeCharacterId]);

  const playlistRef = useRef(playlist);
  playlistRef.current = playlist;

  const currentTrack = playlist.find(track => track.id === currentId) || null;
  const totalTracks = groups.reduce((sum, group) => sum + group.tracks.length, 0);

  const refresh = useCallback(async () => {
    try {
      setGroups(await loadRadioGroups());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUpdated = () => void refresh();
    window.addEventListener("archive-updated", onUpdated);
    window.addEventListener("chat-messages-updated", onUpdated);
    return () => {
      window.removeEventListener("archive-updated", onUpdated);
      window.removeEventListener("chat-messages-updated", onUpdated);
    };
  }, [refresh]);

  const stopAudio = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch { /* ignore */ }
    }
    if (revokeRef.current) {
      URL.revokeObjectURL(revokeRef.current);
      revokeRef.current = "";
    }
    setPlaying(false);
    setProgress(0);
    setElapsed(0);
    setDuration(0);
  }, []);

  const advance = useCallback((step: 1 | -1) => {
    const list = playlistRef.current;
    if (list.length === 0) return;
    const index = currentIdRef.current ? list.findIndex(track => track.id === currentIdRef.current) : -1;
    const nextIndex = index < 0 ? 0 : index + step;
    if (nextIndex < 0 || nextIndex >= list.length) {
      stopAudio();
      setCurrentId(null);
      return;
    }
    void playTrackRef.current(list[nextIndex]);
  }, [stopAudio]);

  const playTrack = useCallback(async (track: RadioTrack) => {
    stopAudio();
    setNotice(null);
    setCurrentId(track.id);
    try {
      const url = await resolvePlayableUrl(track.mediaUrl, revokeRef);
      if (!url) {
        setNotice("这条语音的音频已经被清理，换一条听听吧");
        return;
      }
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onplay = () => setPlaying(true);
      audio.onpause = () => setPlaying(false);
      audio.onended = () => {
        // 「播完这首就停」：到这条语音结束为止，不再自动续播
        if (timerMinutesRef.current === -1) {
          setPlaying(false);
          return;
        }
        advance(1);
      };
      audio.onerror = () => {
        setPlaying(false);
        setNotice("这条语音无法播放，可能音频已损坏");
      };
      audio.ontimeupdate = () => {
        if (audio.duration > 0) {
          setProgress((audio.currentTime / audio.duration) * 100);
          setElapsed(audio.currentTime);
        }
      };
      audio.onloadedmetadata = () => {
        if (Number.isFinite(audio.duration)) setDuration(audio.duration);
      };
      await audio.play();
    } catch {
      setPlaying(false);
      setNotice("这条语音无法播放");
    }
  }, [advance, stopAudio]);
  playTrackRef.current = playTrack;

  // 定时停止：到点就停播；倒计时每秒刷新一次
  useEffect(() => {
    if (timerMinutes <= 0) {
      setTimerRemaining(0);
      return;
    }
    const endAt = Date.now() + timerMinutes * 60 * 1000;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      setTimerRemaining(remaining);
      if (remaining <= 0) {
        stopAudio();
        setCurrentId(null);
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [timerMinutes, stopAudio]);

  useEffect(() => () => {
    audioRef.current?.pause();
    if (revokeRef.current) URL.revokeObjectURL(revokeRef.current);
  }, []);

  // 侧滑/返回键：先停播 + 退出角色筛选，最后才让桌面壳关掉电台
  useEffect(() => {
    const handler = (event: Event) => {
      if (playing) {
        event.preventDefault();
        stopAudio();
        return;
      }
      if (activeCharacterId) {
        event.preventDefault();
        setActiveCharacterId(null);
      }
    };
    window.addEventListener("float:back", handler);
    return () => window.removeEventListener("float:back", handler);
  }, [playing, activeCharacterId, stopAudio]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) {
      if (currentTrack) void playTrack(currentTrack);
      else if (playlist.length > 0) void playTrack(playlist[0]);
      return;
    }
    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  };

  const visibleGroups = activeCharacterId
    ? groups.filter(group => group.characterId === activeCharacterId)
    : groups;

  return (
    <section className="sr-app">
      <style>{RADIO_STYLES}</style>
      <header className="sr-header">
        <button type="button" className="sr-back" onClick={onClose} aria-label="返回">
          <ChevronLeft size={20} strokeWidth={2} />
        </button>
        <h1 className="sr-title">睡眠电台</h1>
        <span className="sr-header-note">{totalTracks} 条</span>
      </header>

      <main className="sr-scroll">
        <div className="sr-hero">
          <div className="sr-hero-icon"><Moon size={22} strokeWidth={1.8} /></div>
          <div>
            <strong>夜里，听他们说说话</strong>
            <span>自动收录所有已经生成的语音，按角色分好，顺序播放</span>
          </div>
        </div>

        {notice ? <div className="sr-notice">{notice}</div> : null}

        <nav className="sr-chars">
          <button
            type="button"
            className={`sr-chip${activeCharacterId === null ? " sr-chip-on" : ""}`}
            onClick={() => setActiveCharacterId(null)}
          >
            <Radio size={14} strokeWidth={1.8} />
            全部
            <em>{totalTracks}</em>
          </button>
          {groups.map(group => (
            <button
              key={group.characterId}
              type="button"
              className={`sr-chip${activeCharacterId === group.characterId ? " sr-chip-on" : ""}`}
              onClick={() => setActiveCharacterId(group.characterId)}
            >
              {group.characterAvatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={group.characterAvatar} alt="" />
              ) : (
                <span className="sr-chip-initial">{group.characterName.slice(0, 1)}</span>
              )}
              {group.characterName}
              <em>{group.tracks.length}</em>
            </button>
          ))}
        </nav>

        <section className="sr-list">
          {loading ? (
            <div className="sr-empty">正在翻找语音…</div>
          ) : playlist.length === 0 ? (
            <div className="sr-empty">
              还没有生成过语音
              <small>在聊天里点一下语音条，合成完成后就会自动收进来</small>
            </div>
          ) : (
            visibleGroups.map(group => (
              <div key={group.characterId} className="sr-group">
                {activeCharacterId ? null : (
                  <div className="sr-group-head">
                    {group.characterAvatar ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={group.characterAvatar} alt="" />
                    ) : (
                      <span className="sr-chip-initial">{group.characterName.slice(0, 1)}</span>
                    )}
                    <span>{group.characterName}</span>
                    <em>{group.tracks.length} 条</em>
                  </div>
                )}
                {group.tracks.map(track => {
                  const active = track.id === currentId;
                  return (
                    <button
                      key={track.id}
                      type="button"
                      className={`sr-track${active ? " sr-track-on" : ""}`}
                      onClick={() => {
                        if (active && playing) {
                          audioRef.current?.pause();
                        } else if (active) {
                          void audioRef.current?.play();
                        } else {
                          void playTrack(track);
                        }
                      }}
                    >
                      <span className="sr-track-play">
                        {active && playing ? <Pause size={14} strokeWidth={2} /> : <Play size={14} strokeWidth={2} />}
                      </span>
                      <span className="sr-track-body">
                        <span className="sr-track-text">{excerpt(track.text)}</span>
                        <span className="sr-track-time">{formatArchiveTime(track.createdAt)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </section>
      </main>

      <div className="sr-player">
        <div className="sr-timer">
          <span className="sr-timer-label"><Timer size={13} strokeWidth={1.8} /> 停止</span>
          {TIMER_OPTIONS.map(option => (
            <button
              key={option.value}
              type="button"
              className={`sr-timer-btn${timerMinutes === option.value ? " sr-timer-btn-on" : ""}${option.value === -1 && timerMinutes === -1 ? " sr-timer-last" : ""}`}
              onClick={() => setTimerMinutes(option.value)}
            >
              {option.label}
            </button>
          ))}
          {timerMinutes > 0 && timerRemaining > 0 ? <em className="sr-timer-left">{formatClock(timerRemaining)}</em> : null}
        </div>

        <div className="sr-playbar">
          <button type="button" className="sr-skip" onClick={() => advance(-1)} aria-label="上一条">
            <SkipBack size={18} strokeWidth={2} />
          </button>
          <button type="button" className="sr-main-play" onClick={togglePlay} aria-label={playing ? "暂停" : "播放"}>
            {playing ? <Pause size={22} strokeWidth={2} /> : <Play size={22} strokeWidth={2} />}
          </button>
          <button type="button" className="sr-skip" onClick={() => advance(1)} aria-label="下一条">
            <SkipForward size={18} strokeWidth={2} />
          </button>
          <div className="sr-now">
            <span className="sr-now-text">{currentTrack ? excerpt(currentTrack.text, 26) : "选一条语音开始"}</span>
            <span className="sr-now-meta">
              {currentTrack ? currentTrack.characterName : "睡眠电台"}
              {duration > 0 ? ` · ${formatClock(elapsed)} / ${formatClock(duration)}` : ""}
            </span>
            <div className="sr-progress"><div style={{ width: `${progress}%` }} /></div>
          </div>
        </div>
      </div>
    </section>
  );
}

function formatArchiveTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const RADIO_STYLES = `
.sr-app{position:absolute;inset:0;display:flex;flex-direction:column;z-index:2;color:#ece8f6;
  background:radial-gradient(120% 80% at 20% 0%, #2a2440 0%, #161722 48%, #0e0f16 100%);
  font-family:var(--ui-font, system-ui);overflow:hidden}
.sr-header{display:flex;align-items:center;gap:10px;padding:calc(var(--status-bar-drop,0px) + 14px) 16px 12px;
  border-bottom:1px solid rgba(255,255,255,.08)}
.sr-back{display:flex;align-items:center;justify-content:center;width:34px;height:34px;border:none;border-radius:50%;
  background:rgba(255,255,255,.08);color:#ece8f6;cursor:pointer}
.sr-title{margin:0;flex:1;text-align:center;font-size:15px;letter-spacing:.2em;font-weight:600}
.sr-header-note{font-size:11px;opacity:.5;min-width:44px;text-align:right}
.sr-scroll{flex:1;overflow-y:auto;padding:14px 14px 18px}
.sr-hero{display:flex;align-items:center;gap:12px;padding:14px;border-radius:18px;
  background:linear-gradient(135deg,rgba(140,120,220,.22),rgba(70,90,160,.14));
  border:1px solid rgba(255,255,255,.08);margin-bottom:12px}
.sr-hero-icon{display:flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:50%;
  background:rgba(180,165,255,.16);color:#cfc4ff}
.sr-hero strong{display:block;font-size:14px;font-weight:600}
.sr-hero span{display:block;margin-top:3px;font-size:11.5px;line-height:1.6;opacity:.55}
.sr-notice{margin:0 0 12px;padding:9px 12px;border-radius:12px;background:rgba(255,120,120,.12);
  color:#ffb9b9;font-size:12px;line-height:1.5}
.sr-chars{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 12px;scrollbar-width:none}
.sr-chars::-webkit-scrollbar{display:none}
.sr-chip{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:7px 11px;border-radius:999px;
  border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.06);color:#dcd7ee;font-size:12px;cursor:pointer}
.sr-chip-on{background:#8f7fd8;border-color:#8f7fd8;color:#fff}
.sr-chip img,.sr-chip-initial{width:18px;height:18px;border-radius:50%;object-fit:cover;background:rgba(255,255,255,.18);
  display:flex;align-items:center;justify-content:center;font-size:10px}
.sr-chip em{font-style:normal;font-size:10px;opacity:.6}
.sr-list{display:flex;flex-direction:column;gap:12px}
.sr-group{display:flex;flex-direction:column;gap:2px}
.sr-group-head{display:flex;align-items:center;gap:8px;font-size:12px;opacity:.7;padding:4px 4px 6px}
.sr-group-head img,.sr-group-head .sr-chip-initial{width:20px;height:20px;border-radius:50%;object-fit:cover}
.sr-group-head em{margin-left:auto;font-style:normal;font-size:10px;opacity:.7}
.sr-track{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:10px 12px;border-radius:14px;
  border:1px solid transparent;background:rgba(255,255,255,.045);color:#ece8f6;cursor:pointer;
  transition:background .2s ease,border-color .2s ease}
.sr-track.sr-track-on{background:rgba(150,130,235,.2);border-color:rgba(170,150,255,.4)}
.sr-track-play{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;
  background:rgba(255,255,255,.1);color:#cfc4ff;flex:0 0 auto}
.sr-track-on .sr-track-play{background:#8f7fd8;color:#fff}
.sr-track-body{display:flex;flex-direction:column;gap:3px;min-width:0}
.sr-track-text{font-size:13px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sr-track-time{font-size:10px;opacity:.45}
.sr-empty{display:flex;flex-direction:column;gap:8px;align-items:center;padding:50px 20px;text-align:center;
  font-size:13px;opacity:.6}
.sr-empty small{font-size:11.5px;opacity:.8;line-height:1.6}
.sr-player{padding:8px 12px calc(env(safe-area-inset-bottom, 0px) + 12px);
  background:rgba(14,15,22,.86);border-top:1px solid rgba(255,255,255,.09);backdrop-filter:blur(14px)}
.sr-timer{display:flex;align-items:center;gap:5px;overflow-x:auto;padding-bottom:8px}
.sr-timer::-webkit-scrollbar{display:none}
.sr-timer-label{flex:0 0 auto;display:flex;align-items:center;gap:3px;font-size:10.5px;opacity:.55;margin-right:2px}
.sr-timer-btn{flex:0 0 auto;padding:4px 9px;border-radius:999px;border:1px solid rgba(255,255,255,.1);
  background:transparent;color:#cfc9e0;font-size:10.5px;cursor:pointer}
.sr-timer-btn-on{background:rgba(150,130,235,.35);border-color:rgba(170,150,255,.6);color:#fff}
.sr-timer-left{margin-left:auto;font-style:normal;font-size:11px;color:#ffd9a6;flex:0 0 auto;padding-left:8px}
.sr-playbar{display:flex;align-items:center;gap:8px}
.sr-skip{display:flex;align-items:center;justify-content:center;width:34px;height:34px;border:none;border-radius:50%;
  background:rgba(255,255,255,.07);color:#cfc9e0;cursor:pointer;flex:0 0 auto}
.sr-main-play{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border:none;border-radius:50%;
  background:linear-gradient(135deg,#a293ec,#7a68c8);color:#fff;cursor:pointer;flex:0 0 auto;
  box-shadow:0 6px 18px rgba(140,120,220,.35)}
.sr-now{flex:1;min-width:0}
.sr-now-text{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sr-now-meta{display:block;font-size:10px;opacity:.5;margin-top:2px}
.sr-progress{height:3px;margin-top:6px;border-radius:2px;background:rgba(255,255,255,.1);overflow:hidden}
.sr-progress div{height:100%;background:#a293ec;transition:width .2s linear}
`;
