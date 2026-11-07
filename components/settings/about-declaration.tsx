"use client";

import { Info, ShieldAlert, Heart } from "lucide-react";
import { WEB_BUILD_VERSION } from "@/lib/app-version";

export function AboutDeclaration() {
    // 同时显示网页版本和实际站点地址：设备一直跑旧缓存时，用户能一眼看出
    // 自己加载的到底是不是仓库最新构建，也方便排查「装的是哪个部署」。
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    return (
        <div className="flex flex-col gap-5 h-full">
            <div className="g-card" style={{ padding: "10px 14px" }}>
                <div className="flex flex-col gap-1">
                    <span className="menu-desc ts-12 !mt-0">网页版本：{WEB_BUILD_VERSION}</span>
                    {origin ? <span className="menu-desc ts-12 !mt-0" style={{ wordBreak: "break-all" }}>加载站点：{origin}</span> : null}
                    <span className="menu-desc ts-12 !mt-0">看不到最新版本号时，说明设备还在跑旧缓存。</span>
                </div>
            </div>
            <p className="card-section-label m-0 mx-2">免责声明</p>

            <div className="g-card">
                <div className="flex items-start gap-3">
                    <ShieldAlert size={20} className="shrink-0 mt-0.5 text-[var(--c-warning)]" />
                    <div className="flex flex-col gap-2">
                        <span className="menu-label font-semibold">AI 生成内容声明</span>
                        <span className="menu-desc ts-13 leading-relaxed !mt-0">
                            本应用内的所有角色对话、动态内容均为人工智能模型自动生成。生成内容不代表本平台的立场与观点，亦不对应任何现实中的人物、事件。用户应当自行辨别并承担使用风险。
                        </span>
                    </div>
                </div>
                <div className="ui-row-divider !mx-0" />
                <div className="flex items-start gap-3">
                    <Info size={20} className="shrink-0 mt-0.5 text-[var(--c-icon-active)]" />
                    <div className="flex flex-col gap-2">
                        <span className="menu-label font-semibold">隐私与数据安全</span>
                        <span className="menu-desc ts-13 leading-relaxed !mt-0">
                            您的日记、聊天记录及身份预设等敏感数据默认保存在本地浏览器中（LocalStorage/IndexedDB）。清理浏览器缓存可能会导致数据丢失，请注意妥善备份。
                        </span>
                    </div>
                </div>
            </div>

            <p className="card-section-label m-0 mx-2">相关信息</p>

            <div className="flex flex-col gap-2">
                <button className="g-card flex-row items-center">
                    <Heart size={20} fill="currentColor" className="shrink-0 text-[var(--c-icon-rose)]" />
                    <span className="menu-label flex-1">支持开发者</span>
                    <span className="menu-desc !mt-0">请我喝杯咖啡</span>
                </button>
            </div>

        </div>
    );
}
