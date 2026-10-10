import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { Criteria, AgentInput, UiAdapter } from "@mp-pi/contracts";
import { AgentRuntime } from "../src/core/runtime.js";
import type { Media, Resource } from "../src/domain/types.js";
import { normalizeMedia, normalizeResource } from "../src/domain/resources.js";
import type {
  MediaBackend,
  DownloadResult,
  LibraryResult,
  ResolvedLink,
} from "../src/integrations/moviepilot.js";
import type {
  OfflineSubmission,
  OfflineTask,
  OfflinePluginStatus,
  Subscription,
  TransferHistory,
} from "../src/integrations/moviepilot-contracts.js";
import type {
  TransferCommand,
  TransferQuery,
  TransferRecord,
  TransferPlan,
} from "../src/integrations/transfers.js";
import { createHash } from "node:crypto";
import type { MikanPage } from "../src/integrations/mikan.js";

export function mikanRelease(title: string, index: number): MikanPage["items"][number] {
  const downloadUrl = `https://mikan.example/Download/20261007/${index}.torrent`;
  return {
    id: createHash("sha256").update(downloadUrl).digest("hex"),
    title,
    sourceUrl: `https://mikan.example/Home/Episode/${index}`,
    downloadUrl,
    size: 512 * 2 ** 20,
    publishedAt: "2026-10-07T12:30:00",
  };
}

export function transferRecord(id: string): TransferRecord {
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  return {
    id,
    filename: `Hamnet.${id}.mkv`,
    title: "",
    error: "未识别到媒体信息",
    date: "2026-10-07 12:00:00",
    revision: digest(`revision-${id}`),
    sourceKey: digest(`source-${id}`),
    cleanupTarget: false,
  };
}

export const projectDir = resolve(
  import.meta.dirname,
  import.meta.url.endsWith(".ts") ? ".." : "../..",
);
export const media = normalizeMedia({
  source: "themoviedb",
  media_id: "858024",
  title: "哈姆奈特",
  type: "电影",
  year: "2025",
  overview: "Hamnet 的电影简介",
  tmdb_id: 858024,
  douban_id: null,
  bangumi_id: null,
  anilist_id: null,
});
export function resource(title: string, index = 1): Resource {
  const result = normalizeResource(
    {
      media_info: media.raw,
      meta_info: {},
      torrent_info: {
        title,
        description: "CHS EN",
        size: 12 * 1024 ** 3,
        seeders: 25,
        site: 1,
        site_name: "示例站点",
        enclosure: `magnet:?xt=urn:btih:${index.toString(16).padStart(40, "0")}`,
        site_cookie: "private-tracker-cookie",
      },
    },
    media,
  );
  if (!result) {
    throw new Error("Fixture resource must match its media");
  }
  return result;
}

export class FakeBackend implements MediaBackend {
  mikanQueries: Array<{ keyword: string; group?: string }> = [];
  mikanReleases = [
    mikanRelease("[喵萌奶茶屋] 花织同学 [01][1080p][CHS]", 1),
    mikanRelease("[喵萌奶茶屋] 花织同学 [02][1080p][CHS]", 2),
    mikanRelease("[喵萌奶茶屋] 花织同学 [02][1080p][CHT]", 3),
    mikanRelease("[其他字幕组] 花织同学 [01][720p][CHS]", 4),
  ];
  resolvedUrls: string[] = [];
  async searchMikan(query: { keyword: string; group?: string }): Promise<MikanPage> {
    this.mikanQueries.push(query);
    return {
      searchUrl: `https://mikan.example/Home/Search?${new URLSearchParams({ searchstr: [query.keyword, query.group].filter(Boolean).join(" ") })}`,
      received: this.mikanReleases.length,
      items: this.mikanReleases,
    };
  }
  transferRecords = [transferRecord("101"), transferRecord("102")];
  transferCalls: TransferCommand[] = [];
  transferErrors = new Map<string, Error>();
  async listTransferFailures(query: TransferQuery) {
    return {
      ...query,
      total: this.transferRecords.length,
      items: this.transferRecords.slice((query.page - 1) * query.count, query.page * query.count),
    };
  }
  async getTransferRecord(id: string) {
    const record = this.transferRecords.find((item) => item.id === id);
    if (!record) {
      throw new Error("Record missing");
    }
    return record;
  }
  async previewTransfer(command: TransferCommand): Promise<TransferPlan> {
    const record = await this.getTransferRecord(command.historyId);
    return {
      planHash: record.revision,
      cleanupTarget: record.cleanupTarget,
      files: [
        {
          sourceKey: record.sourceKey,
          targetKey: createHash("sha256").update(`target-${record.id}`).digest("hex"),
          filename: record.filename,
          targetFilename: `哈姆奈特.${record.id}.mkv`,
          title: command.identification?.media.title ?? "哈姆奈特",
          season: null,
          episode: null,
        },
      ],
    };
  }
  async retryTransfer(command: TransferCommand, _planHash: string): Promise<boolean> {
    this.transferCalls.push(command);
    const error = this.transferErrors.get(command.historyId);
    if (error) {
      throw error;
    }
    return true;
  }
  resources = [
    resource("Hamnet.2025.2160p.WEB-DL.DDP5.1.CHS", 1),
    resource("Hamnet.2025.1080p.BluRay.DTS5.1.EN", 2),
  ];
  downloads: DownloadResult[] = [];
  offline: OfflineTask[] = [];
  offlineStatus: OfflinePluginStatus = {
    version: "1.1.1",
    enabled: false,
    running: false,
    logged_in: true,
    credential_saved: true,
    target_folder: "/云下载",
    rss_count: 1,
    login_status: {
      state: "valid",
      message: "115 离线接口可用",
      checked_at: "2026-10-11 02:00:00",
    },
  };
  statusCalls: boolean[] = [];
  library: LibraryResult = { exists: false };
  transfers: TransferHistory[] = [];
  subscriptions: Subscription[] = [{ id: 1, name: "示例剧集", season: 1, state: "R" }];
  submission: OfflineSubmission = {
    id: "offline-batch",
    status: "running",
    submitted: 0,
    failed: 0,
    duplicated: 0,
    results: [],
  };
  downloadCalls = 0;
  submitCalls = 0;
  subscribeCalls = 0;
  changeCalls = 0;
  submittedLinks: string[] = [];
  submitError?: Error;

  async searchMedia(_query: string): Promise<Media[]> {
    return [media];
  }
  async searchResources(_media: Media, _criteria: Criteria): Promise<Resource[]> {
    return this.resources;
  }
  async getDownloading() {
    this.downloadCalls++;
    return [{ hash: "test-task", title: "Hamnet", state: "downloading", progress: 35 }];
  }
  async getDownloadStates(_hashes: string[]): Promise<DownloadResult[]> {
    return this.downloads;
  }
  async submitDownload(_media: Media, selected: Resource): Promise<string> {
    this.submitCalls++;
    if (this.submitError) {
      throw this.submitError;
    }
    return selected.infoHash!;
  }
  async resolveLinks(links: string[]): Promise<ResolvedLink[]> {
    this.resolvedUrls.push(...links);
    return links.map((link) => {
      const infoHash = link.startsWith("https://mikan.example/")
        ? createHash("sha1").update(link).digest("hex")
        : "a".repeat(40);
      return { magnet: `magnet:?xt=urn:btih:${infoHash}`, infoHash };
    });
  }
  async submit115(links: string[]): Promise<string> {
    this.submitCalls++;
    this.submittedLinks = links;
    if (this.submitError) {
      throw this.submitError;
    }
    return this.submission.id;
  }
  async get115Submission(): Promise<OfflineSubmission> {
    return this.submission;
  }
  async get115Status(refresh: boolean): Promise<OfflinePluginStatus> {
    this.statusCalls.push(refresh);
    return this.offlineStatus;
  }
  async get115Tasks(): Promise<OfflineTask[]> {
    return this.offline;
  }
  async checkLibrary(_media: Media, _criteria: Criteria): Promise<LibraryResult> {
    return this.library;
  }
  async getTransferHistory(_media: Media): Promise<TransferHistory[]> {
    return this.transfers;
  }
  async listSubscriptions(): Promise<Subscription[]> {
    return this.subscriptions;
  }
  async subscribe(_media: Media, _season: number | undefined): Promise<string> {
    this.subscribeCalls++;
    return "2";
  }
  async changeSubscription(_id: string, _operation: "pause" | "resume" | "delete"): Promise<void> {
    this.changeCalls++;
  }
}

export function input(
  requestId: string,
  text: string,
  conversationId = "movie",
  userId = "owner",
): AgentInput {
  return { requestId, text, conversationId, userId };
}

export async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-agent-test-"));
  const faux = fauxProvider({ provider: "offline-test", tokensPerSecond: 1_000_000 });
  const models = await ModelRuntime.create({
    authPath: join(dataDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  models.registerNativeProvider(faux.provider);
  const backend = new FakeBackend();
  const errors: unknown[] = [];
  const options = {
    projectDir,
    dataDir,
    model: faux.getModel(),
    modelRuntime: models,
    backend,
    onError: (error: unknown) => {
      errors.push(error);
    },
  };
  let runtime = await AgentRuntime.create(options);
  t.after(async () => {
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    get runtime() {
      return runtime;
    },
    dataDir,
    faux,
    options,
    backend,
    errors,
    handle: (request: AgentInput, adapter?: UiAdapter) => {
      runtime.store.ensureConversation(request, request.text);
      return runtime.handle(request, adapter);
    },
    reopen: async () => {
      await runtime.close();
      runtime = await AgentRuntime.create(options);
    },
  };
}
