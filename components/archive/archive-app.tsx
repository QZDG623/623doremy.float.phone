"use client";

// 收藏夹：四栏（聊天记录 / 剧情收藏 / 图片 / 语音），每一栏按角色做成「档案」。
//
// 交互：
//   一进来是档案墙 —— 每个角色一张大卡片（档案编号 + 名字 + 素材数量）；
//   点开卡片进到角色详情，看到这一类里属于 TA 的全部素材，可以逐条删除。
//
// 这一屏刻意做得像纸质档案：编号、色卡、贴纸，而不是又一个列表。

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, Image as ImageIcon, MessageSquareText, Mic, Trash2, BookOpenText } from "lucide-react";

import {
  ARCHIVE_KIND_LABEL,
  groupArchiveByCharacter,
  loadArchiveEntries,
  removeArchiveEntry,
  syncGeneratedChatImages,
  type ArchiveEntry,
  type ArchiveKind,
} from "@/lib/archive-storage";
import { getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";
import { isMediaStoreRef, loadMediaObjectUrl } from "@/lib/media-cache-storage";

/** 档案卡片的配色（与用户给的设计图一致：莫兰迪色，纸感）。 */
const CARD_TONES = [
  { cover: "#b79aa8", tab: "#8f6f7f" },
  { cover: "#c7bb96", tab: "#a1976e" },
  { cover: "#b6add6", tab: "#8e86b4" },
  { cover: "#3c4a6e", tab: "#2a3653" },
  { cover: "#6b74bd", tab: "#525aa0" },
];
const DARK_TONE = new Set([3, 4]);

const TABS: { kind: ArchiveKind; icon: ReactNode }[] = [
  { kind: "chat", icon: <MessageSquareText size={16} strokeWidth={1.8} /> },
  { kind: "story", icon: <BookOpenText size={16} strokeWidth={1.8} /> },
  { kind: "image", icon: <ImageIcon size={16} strokeWidth={1.8} /> },
  { kind: "voice", icon: <Mic size={16} strokeWidth={1.8} /> },
];

/** 把 media-store:// / asset:// 引用解析成可以直接给 img/audio 用的地址。 */
function useResolvedMediaUrl(raw?: string): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let revoke = "";
    if (!raw) {
      setUrl("");
      return;
    }
    if (raw.startsWith("asset://")) {
      getChatImageFromIndexedDB(raw.slice(8)).then(dataUrl => setUrl(dataUrl || ""));
      return;
    }
    if (!isMediaStoreRef(raw)) {
      setUrl(raw);
      return;
    }
    loadMediaObjectUrl(raw).then(objUrl => {
      if (objUrl) {
        revoke = objUrl;
        setUrl(objUrl);
      }
    });
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [raw]);
  return url;
}

function ArchiveImage({ url }: { url?: string }) {
  const resolved = useResolvedMediaUrl(url);
  if (!resolved) {
    return <div className="arc-media-placeholder">图片已被清理</div>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="arc-media-image" src={resolved} alt="收藏的图片" loading="lazy" />;
}

function ArchiveVoice({ url, text }: { url?: string; text: string }) {
  const resolved = useResolvedMediaUrl(url);
  return (
    <div className="arc-voice">
      {resolved ? (
        <audio className="arc-voice-audio" controls preload="none" src={resolved} />
      ) : (
        <span className="arc-voice-missing">语音文件已被清理</span>
      )}
      {text ? <p className="arc-voice-text">{text}</p> : null}
    </div>
  );
}

export function ArchiveApp({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<ArchiveKind>("chat");
  const [version, setVersion] = useState(0);
  const [openCharacterId, setOpenCharacterId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(() => setVersion(v => v + 1), []);

  useEffect(() => {
    const onUpdated = () => refresh();
    window.addEventListener("archive-updated", onUpdated);
    // 打开时扫一次生成的图片：收藏夹不该要求用户记得「先同步」
    setSyncing(true);
    void syncGeneratedChatImages().finally(() => {
      setSyncing(false);
      refresh();
    });
    return () => window.removeEventListener("archive-updated", onUpdated);
  }, [refresh]);

  const entries = useMemo(() => loadArchiveEntries(), [version]);

  const entriesOfKind = useMemo(
    () => entries.filter(entry => entry.kind === kind),
    [entries, kind],
  );

  const groups = useMemo(() => groupArchiveByCharacter(entriesOfKind), [entriesOfKind]);

  const selected = groups.find(group => group.characterId === openCharacterId) || null;

  const toneIndex = useCallback((characterId: string) => {
    let hash = 0;
    for (let i = 0; i < characterId.length; i++) hash = (hash * 31 + characterId.charCodeAt(i)) >>> 0;
    return hash % CARD_TONES.length;
  }, []);

  return (
    <section className="arc-app">
      <style>{ARC_STYLES}</style>
      <header className="arc-header">
        <button type="button" className="arc-back" onClick={openCharacterId ? () => setOpenCharacterId(null) : onClose} aria-label="返回">
          <ChevronLeft size={20} strokeWidth={2} />
        </button>
        <h1 className="arc-title">ARCHIVE ROOM</h1>
        <span className="arc-header-note">{selected ? selected.code : "收藏夹"}</span>
      </header>

      {!selected && (
        <>
          <nav className="arc-tabs">
            {TABS.map(tab => (
              <button
                key={tab.kind}
                type="button"
                className={`arc-tab${kind === tab.kind ? " arc-tab-active" : ""}`}
                onClick={() => {
                  setKind(tab.kind);
                  setOpenCharacterId(null);
                }}
              >
                {tab.icon}
                <span>{ARCHIVE_KIND_LABEL[tab.kind]}</span>
                <em>{entries.filter(entry => entry.kind === tab.kind).length}</em>
              </button>
            ))}
          </nav>

          <main className="arc-wall">
            {groups.length === 0 ? (
              <div className="arc-empty">
                {syncing ? "正在整理档案…" : `还没有${ARCHIVE_KIND_LABEL[kind]}素材`}
                <small>{kind === "image" ? "角色生成图片后会自动收进这里" : "在聊天或剧情里长按消息，点「收藏」"}</small>
              </div>
            ) : (
              <div className="arc-grid">
                {groups.map(group => {
                  const tone = CARD_TONES[toneIndex(group.characterId)];
                  const dark = DARK_TONE.has(toneIndex(group.characterId));
                  return (
                    <button
                      key={group.characterId}
                      type="button"
                      className={`arc-card${dark ? " arc-card-dark" : ""}`}
                      style={{ background: tone.cover, borderColor: tone.tab }}
                      onClick={() => setOpenCharacterId(group.characterId)}
                    >
                      <span className="arc-card-tab" style={{ background: tone.tab }}>{group.code}</span>
                      <span className="arc-card-sheet" aria-hidden>
                        <span className="arc-card-lines" />
                        {group.characterAvatar ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img className="arc-card-sticker" src={group.characterAvatar} alt={group.characterName} />
                        ) : (
                          <span className="arc-card-initial">{group.characterName.slice(0, 1)}</span>
                        )}
                      </span>
                      <span className="arc-card-name">{group.characterName}</span>
                      <span className="arc-card-sub">个人档案</span>
                      <span className="arc-card-count">
                        {group.entries.length > 8 ? "8+" : group.entries.length} 份素材
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </main>
        </>
      )}

      {selected && (
        <main className="arc-detail">
          <div className="arc-detail-head">
            {selected.characterAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="arc-detail-avatar" src={selected.characterAvatar} alt={selected.characterName} />
            ) : null}
            <div>
              <strong>{selected.characterName}</strong>
              <span>{ARCHIVE_KIND_LABEL[kind]} · {selected.entries.length} 份</span>
            </div>
          </div>
          <div className="arc-detail-list">
            {selected.entries.map(entry => (
              <ArchiveItem key={entry.id} entry={entry} onRemove={refresh} />
            ))}
          </div>
        </main>
      )}
    </section>
  );
}

function ArchiveItem({ entry, onRemove }: { entry: ArchiveEntry; onRemove: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <article className="arc-item">
      <div className="arc-item-meta">
        <span>{formatArchiveTime(entry.createdAt)}</span>
        {entry.auto ? <em>自动归档</em> : null}
        <button
          type="button"
          className="arc-item-delete"
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              window.setTimeout(() => setConfirming(false), 2500);
              return;
            }
            removeArchiveEntry(entry.id);
            onRemove();
          }}
        >
          <Trash2 size={14} strokeWidth={1.8} />
          {confirming ? "确认删除" : "删除"}
        </button>
      </div>
      {entry.kind === "image" ? <ArchiveImage url={entry.mediaUrl} /> : null}
      {entry.kind === "voice" ? <ArchiveVoice url={entry.mediaUrl} text={entry.text} /> : null}
      {entry.kind !== "image" && entry.kind !== "voice" ? (
        <p className="arc-item-text">{entry.text}</p>
      ) : null}
      {entry.kind === "image" && entry.text ? <p className="arc-item-caption">{entry.text}</p> : null}
    </article>
  );
}

function formatArchiveTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const ARC_STYLES = `
.arc-app{position:absolute;inset:0;display:flex;flex-direction:column;background:#f4f1ea;color:#26222a;
  font-family:var(--ui-font, system-ui);overflow:hidden;z-index:2}
.arc-header{display:flex;align-items:center;gap:10px;padding:calc(var(--status-bar-drop,0px) + 14px) 16px 12px;
  background:#f4f1ea;border-bottom:1px solid rgba(38,34,42,.08)}
.arc-back{display:flex;align-items:center;justify-content:center;width:34px;height:34px;border:none;border-radius:50%;
  background:transparent;color:#26222a;cursor:pointer}
.arc-title{margin:0;flex:1;text-align:center;font-size:15px;letter-spacing:.34em;font-weight:600;font-family:ui-monospace,Menlo,monospace}
.arc-header-note{font-size:11px;letter-spacing:.12em;opacity:.55;font-family:ui-monospace,Menlo,monospace;min-width:34px;text-align:right}
.arc-tabs{display:flex;gap:6px;padding:10px 12px 4px;overflow-x:auto}
.arc-tab{flex:1 0 auto;display:flex;align-items:center;gap:5px;padding:8px 10px;border:none;border-radius:12px;
  background:rgba(38,34,42,.06);color:#26222a;font-size:12px;cursor:pointer;white-space:nowrap}
.arc-tab em{font-style:normal;font-size:10px;opacity:.55}
.arc-tab-active{background:#26222a;color:#f7f4ee}
.arc-wall{flex:1;overflow-y:auto;padding:14px 14px 28px}
.arc-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.arc-card{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;
  min-height:168px;padding:44px 14px 16px;border:1px solid;border-radius:16px;cursor:pointer;
  box-shadow:0 6px 18px rgba(38,34,42,.12);overflow:hidden;color:#2d2733}
.arc-card-dark{color:#f1eee8}
.arc-card-tab{position:absolute;top:0;left:16px;padding:5px 12px;border-radius:0 0 8px 8px;
  font-size:10px;letter-spacing:.14em;color:#fff;font-family:ui-monospace,Menlo,monospace}
.arc-card-sheet{position:relative;margin:6px 0 12px;width:100%;height:52px;border-radius:4px;
  background:rgba(255,255,255,.55);box-shadow:0 2px 6px rgba(0,0,0,.08)}
.arc-card-lines{position:absolute;left:10px;right:10px;top:14px;height:24px;
  background:repeating-linear-gradient(180deg,rgba(60,50,60,.35) 0 1px,transparent 1px 8px)}
.arc-card-sticker{position:absolute;right:8px;top:-14px;width:44px;height:52px;object-fit:cover;border-radius:3px;
  border:4px solid #fff;transform:rotate(6deg);box-shadow:0 4px 10px rgba(0,0,0,.18)}
.arc-card-initial{position:absolute;right:12px;top:2px;font-size:26px;opacity:.5;font-weight:700}
.arc-card-name{font-size:20px;font-weight:700;line-height:1.2}
.arc-card-sub{font-size:11px;opacity:.62;letter-spacing:.16em}
.arc-card-count{margin-top:8px;padding-top:8px;border-top:1px dashed rgba(0,0,0,.18);width:100%;
  font-size:11px;opacity:.6;letter-spacing:.08em}
.arc-card-dark .arc-card-count{border-top-color:rgba(255,255,255,.28)}
.arc-empty{display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;
  padding:60px 20px;text-align:center;font-size:14px;opacity:.6}
.arc-empty small{font-size:12px;opacity:.7}
.arc-detail{flex:1;overflow-y:auto;padding:16px 14px 28px}
.arc-detail-head{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.arc-detail-avatar{width:48px;height:48px;border-radius:12px;object-fit:cover}
.arc-detail-head strong{display:block;font-size:18px}
.arc-detail-head span{font-size:11px;opacity:.55;letter-spacing:.1em}
.arc-detail-list{display:flex;flex-direction:column;gap:12px}
.arc-item{background:#fffdf8;border:1px solid rgba(38,34,42,.08);border-radius:14px;padding:12px;
  box-shadow:0 4px 14px rgba(38,34,42,.06)}
.arc-item-meta{display:flex;align-items:center;gap:8px;font-size:10px;opacity:.55;margin-bottom:8px}
.arc-item-meta em{font-style:normal;padding:1px 6px;border-radius:6px;background:rgba(38,34,42,.08);opacity:.8}
.arc-item-delete{margin-left:auto;display:flex;align-items:center;gap:3px;border:none;background:transparent;
  color:#a4475b;font-size:11px;cursor:pointer;padding:2px 4px;border-radius:6px}
.arc-item-text{margin:0;font-size:14px;line-height:1.65;white-space:pre-wrap;word-break:break-word}
.arc-item-caption{margin:8px 0 0;font-size:12px;opacity:.65;line-height:1.5}
.arc-media-image{display:block;width:100%;max-height:340px;object-fit:contain;border-radius:10px;background:#f1eee8}
.arc-media-placeholder{padding:26px 0;text-align:center;font-size:12px;opacity:.5;background:#f1eee8;border-radius:10px}
.arc-voice{display:flex;flex-direction:column;gap:8px}
.arc-voice-audio{width:100%;height:38px}
.arc-voice-text{margin:0;font-size:13px;line-height:1.6;white-space:pre-wrap}
.arc-voice-missing{font-size:12px;opacity:.5}
`;
