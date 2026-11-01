import { loadCharacters } from "./character-storage";
import { incrementEventCounter } from "./memory-storage";
import { maybeRunSummarization } from "./memory-summarizer";
import { generateStoryCompletion } from "./story-engine";
import { setStoryGeneratingCharacters } from "./story-generation-prefs";
import { loadStoryMessages, pushStoryMessage, type StorySession } from "./story-storage";

// 剧情生成放在模块级服务里，而不是绑在 StoryApp 组件上：
// 切到其它 App / 切出小手机时剧情页会卸载，但这里的 run 和请求继续跑，
// 生成结束后直接写进存储并广播事件；页面重新挂载时按事件和运行表恢复状态。

export const STORY_GENERATION_EVENT = "story-generation-updated";

export type StoryGenerationState = "started" | "streaming" | "finished" | "failed" | "cancelled";

export type StoryGenerationEventDetail = {
  sessionId: string;
  runId: string;
  state: StoryGenerationState;
  /** 流式预览：当前已输出的完整正文（仅 streaming 状态带）。 */
  text?: string;
};

type StoryGenerationRun = {
  runId: string;
  controller: AbortController;
  /** 这次生成涉及的角色：剧情切走后仍要让这些角色的后台主动消息继续让路。 */
  characterIds: string[];
};

const activeRuns = new Map<string, StoryGenerationRun>();

/** 把当前所有在跑的剧情角色同步给 follow-up-service 的让路判定。 */
function syncGeneratingCharacters(): void {
  const ids = new Set<string>();
  for (const run of activeRuns.values()) {
    for (const id of run.characterIds) ids.add(id);
  }
  setStoryGeneratingCharacters([...ids]);
}

function emit(detail: StoryGenerationEventDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(STORY_GENERATION_EVENT, { detail }));
}

/** 当前正在生成的会话 id（页面重新挂载时用来恢复“正在生成”状态）。 */
export function getActiveStoryGeneratingSessionIds(): string[] {
  return [...activeRuns.keys()];
}

export function isStorySessionGenerating(sessionId: string): boolean {
  return activeRuns.has(sessionId);
}

/** 主动停止：中止请求并广播取消状态。 */
export function cancelStoryGeneration(sessionId: string): boolean {
  const run = activeRuns.get(sessionId);
  if (!run) return false;
  run.controller.abort();
  activeRuns.delete(sessionId);
  syncGeneratingCharacters();
  emit({ sessionId, runId: run.runId, state: "cancelled" });
  return true;
}

export type RunStoryGenerationInput = {
  sessionId: string;
  characterId: string;
  session?: StorySession | null;
  floatingChatContext?: string;
  /** 自动开场提示：只作为一次性的用户消息参与本次生成，不落库。 */
  virtualUserText?: string;
  virtualCreatedAt?: string;
  stream?: boolean;
  timeAware?: boolean;
};

/**
 * 跑一轮剧情生成。调用方不需要 await：生成结束会通过 STORY_GENERATION_EVENT 通知。
 * 同一会话已有任务时，新任务会中止旧任务（与原来“重新生成/重试”的语义一致）。
 */
export async function runStoryGeneration(input: RunStoryGenerationInput): Promise<void> {
  const { sessionId, characterId } = input;
  const session = input.session || null;

  const previous = activeRuns.get(sessionId);
  previous?.controller.abort();

  const run: StoryGenerationRun = {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    controller: new AbortController(),
    characterIds: session?.participantIds?.length ? [...session.participantIds] : [characterId],
  };
  activeRuns.set(sessionId, run);
  syncGeneratingCharacters();
  emit({ sessionId, runId: run.runId, state: "started" });

  const isActive = () => {
    const current = activeRuns.get(sessionId);
    return Boolean(current && current.runId === run.runId && !run.controller.signal.aborted);
  };
  const finishAndEmit = (state: StoryGenerationState) => {
    if (activeRuns.get(sessionId)?.runId === run.runId) activeRuns.delete(sessionId);
    syncGeneratingCharacters();
    emit({ sessionId, runId: run.runId, state });
  };

  let lastStreamEmitAt = 0;
  try {
    const history = loadStoryMessages(sessionId);
    const virtualText = input.virtualUserText?.trim();
    if (virtualText) {
      history.push({
        id: `story_auto_${Date.now()}`,
        sessionId,
        role: "user",
        rawContent: virtualText,
        renderedContent: virtualText,
        createdAt: input.virtualCreatedAt || new Date().toISOString(),
      });
    }

    const result = await generateStoryCompletion(characterId, history, {
      sessionFoldTags: session?.foldTags,
      sessionContextExcludedTags: session?.contextExcludedTags,
      settings: session?.settings,
      floatingChatContext: input.floatingChatContext,
      participantIds: session?.participantIds || [characterId],
      storyMemory: {
        independent: session?.independentStory,
        inheritRecentMemory: session?.inheritRecentMemory ?? true,
        startedAt: session?.createdAt,
      },
      signal: run.controller.signal,
      stream: input.stream,
      timeAware: input.timeAware,
      onStreamDelta: input.stream
        ? (text: string) => {
          if (!isActive()) return;
          // 增量很密，节流到 ~80ms 一次，避免整页跟着每个 token 重渲染
          const now = performance.now();
          if (now - lastStreamEmitAt < 80) return;
          lastStreamEmitAt = now;
          emit({ sessionId, runId: run.runId, state: "streaming", text });
        }
        : undefined,
    });

    if (!isActive()) return;

    pushStoryMessage({
      sessionId,
      role: "assistant",
      rawContent: result.rawText,
      renderedContent: result.renderedText,
      storySummary: result.storySummary,
      regexSignature: result.regexSignature,
      parserVersion: result.parserVersion,
    });
    finishAndEmit("finished");

    // 记忆计数与摘要放进后台异步，不拖慢“生成完成”的界面反馈
    const memoryCharacterIds = session?.participantIds?.length ? session.participantIds : [characterId];
    if (memoryCharacterIds.length && !session?.independentStory) {
      void (async () => {
        try {
          const characters = loadCharacters();
          for (const id of memoryCharacterIds) {
            const character = characters.find((item) => item.id === id);
            if (!character) continue;
            incrementEventCounter(character.id);
            incrementEventCounter(character.id);
            await maybeRunSummarization(character.id, character.name);
          }
        } catch (error) {
          console.warn("[StoryGeneration] Memory counter/summarization failed:", error);
        }
      })();
    }
  } catch (error) {
    if (run.controller.signal.aborted || !isActive()) return;
    const errText = error instanceof Error ? error.message : "剧情生成失败，请稍后再试。";
    pushStoryMessage({
      sessionId,
      role: "system",
      rawContent: errText,
      renderedContent: errText,
    });
    finishAndEmit("failed");
  } finally {
    if (activeRuns.get(sessionId)?.runId === run.runId) activeRuns.delete(sessionId);
  }
}
