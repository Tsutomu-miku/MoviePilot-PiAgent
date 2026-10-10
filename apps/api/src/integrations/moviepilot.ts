import { z } from "zod";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Criteria } from "@mp-pi/contracts";
import type { Media, Resource } from "../domain/types.js";
import { BackendBusyError, BackendRejectedError, UnknownSubmissionError } from "../core/errors.js";
import {
  activeDownloadSchema,
  mpContextSchema,
  mpEnvelopeSchema,
  mpMediaSchema,
  offlineTaskSchema,
  offlinePluginStatusSchema,
  submissionSchema,
  subscriptionSchema,
  transferHistorySchema,
  type ActiveDownload,
  type OfflineSubmission,
  type OfflineTask,
  type OfflinePluginStatus,
  type Subscription,
  type TransferHistory,
} from "./moviepilot-contracts.js";
import { normalizeMedia, normalizeResource } from "../domain/resources.js";
import { mikanPageSchema, type MikanPage } from "./mikan.js";
import {
  transferRecordSchema,
  transferPlanSchema,
  type TransferQuery,
  type TransferPage,
  type TransferRecord,
  type TransferCommand,
  type TransferPlan,
} from "./transfers.js";

export interface LibraryResult {
  exists: boolean;
  episodes?: Record<string, number[]>;
  playUrl?: string;
}

export interface ResolvedLink {
  magnet: string;
  infoHash: string;
}

export interface DownloadResult {
  hash: string;
  progress: number;
  completed: boolean;
}

export interface MediaBackend {
  searchMikan(query: { keyword: string; group?: string }, signal?: AbortSignal): Promise<MikanPage>;
  listTransferFailures(query: TransferQuery, signal?: AbortSignal): Promise<TransferPage>;
  getTransferRecord(id: string, signal?: AbortSignal): Promise<TransferRecord>;
  previewTransfer(command: TransferCommand, signal?: AbortSignal): Promise<TransferPlan>;
  retryTransfer(command: TransferCommand, planHash: string, signal?: AbortSignal): Promise<boolean>;
  searchMedia(query: string, signal?: AbortSignal): Promise<Media[]>;
  searchResources(media: Media, criteria: Criteria, signal?: AbortSignal): Promise<Resource[]>;
  getDownloading(signal?: AbortSignal): Promise<ActiveDownload[]>;
  getDownloadStates(hashes: string[], signal?: AbortSignal): Promise<DownloadResult[]>;
  submitDownload(media: Media, resource: Resource, signal?: AbortSignal): Promise<string>;
  resolveLinks(links: string[], signal?: AbortSignal): Promise<ResolvedLink[]>;
  submit115(links: string[], signal?: AbortSignal): Promise<string>;
  get115Status(refresh: boolean, signal?: AbortSignal): Promise<OfflinePluginStatus>;
  get115Submission(signal?: AbortSignal): Promise<OfflineSubmission>;
  get115Tasks(signal?: AbortSignal): Promise<OfflineTask[]>;
  checkLibrary(media: Media, criteria: Criteria, signal?: AbortSignal): Promise<LibraryResult>;
  getTransferHistory(media: Media, signal?: AbortSignal): Promise<TransferHistory[]>;
  listSubscriptions(signal?: AbortSignal): Promise<Subscription[]>;
  subscribe(media: Media, season: number | undefined, signal?: AbortSignal): Promise<string>;
  changeSubscription(
    id: string,
    operation: "pause" | "resume" | "delete",
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface MoviePilotOptions {
  baseUrl: string;
  accessToken?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  downloader?: string;
  savePath?: string;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  mutation?: boolean;
}

export class MoviePilotClient implements MediaBackend {
  private readonly baseUrl: URL;
  private accessToken: string;
  private loginPromise?: Promise<void>;

  constructor(
    private readonly options: MoviePilotOptions,
    private readonly fetchRequest: typeof fetch = fetch,
  ) {
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    this.accessToken = options.accessToken ?? "";
  }

  private async login(): Promise<void> {
    if (!this.options.username || !this.options.password) {
      throw new BackendRejectedError("MoviePilot 登录已过期，请配置账号或更新访问令牌");
    }
    const response = await this.fetchRequest(new URL("login/access-token", this.baseUrl), {
      method: "POST",
      body: new URLSearchParams({
        username: this.options.username,
        password: this.options.password,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new BackendRejectedError(`MoviePilot 登录失败（HTTP ${response.status}）`);
    }
    const token = z.object({ access_token: z.string().min(1) }).parse(await response.json());
    this.accessToken = token.access_token;
  }

  private refreshLogin(): Promise<void> {
    this.loginPromise ??= this.login().finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }

  private parseResponse<T>(schema: z.ZodType<T>, value: unknown, mutation = false): T {
    const result = schema.safeParse(value);
    if (!result.success) {
      if (mutation) {
        throw new UnknownSubmissionError();
      }
      throw new BackendRejectedError("MoviePilot 响应不符合约定，请检查后端版本和插件配置");
    }
    return result.data;
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    if (!this.accessToken && !this.options.apiKey) {
      await this.refreshLogin();
    }
    const send = () =>
      this.fetchRequest(new URL(path, this.baseUrl), {
        method: options.method ?? "GET",
        headers: {
          ...(this.options.apiKey
            ? { "X-API-KEY": this.options.apiKey }
            : { Authorization: `Bearer ${this.accessToken}` }),
          "Content-Type": "application/json",
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.any([
          AbortSignal.timeout(120_000),
          ...(options.signal ? [options.signal] : []),
        ]),
        redirect: "error",
      });
    let response: Response;
    try {
      response = await send();
      if (response.status === 401 && !this.options.apiKey && this.options.username) {
        await this.refreshLogin();
        response = await send();
      }
    } catch (error) {
      if (error instanceof BackendRejectedError) {
        throw error;
      }
      if (options.mutation) {
        throw new UnknownSubmissionError();
      }
      throw new BackendRejectedError("MoviePilot 网络请求失败");
    }
    if (!response.ok) {
      if (options.mutation && response.status >= 500) {
        throw new UnknownSubmissionError();
      }
      throw new BackendRejectedError(`MoviePilot 请求失败（HTTP ${response.status}）`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (options.mutation) {
        throw new UnknownSubmissionError();
      }
      throw new BackendRejectedError("MoviePilot 返回了无效的 JSON 响应");
    }
    return this.parseResponse(schema, body, options.mutation);
  }

  private async envelope<T>(
    path: string,
    dataSchema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.request(path, mpEnvelopeSchema, options);
    if (!response.success) {
      throw this.rejection(response.message);
    }
    return this.parseResponse(dataSchema, response.data, options.mutation);
  }

  private rejection(message: string | null | undefined): BackendRejectedError {
    let detail = message?.trim() || "MoviePilot 未接受请求，未返回具体原因";
    for (const secret of [this.accessToken, this.options.apiKey, this.options.password]) {
      if (secret) {
        detail = detail.replaceAll(secret, "[REDACTED]");
      }
    }
    return new BackendRejectedError(detail);
  }

  async searchMedia(query: string, signal?: AbortSignal): Promise<Media[]> {
    const params = new URLSearchParams({ title: query, count: "30" });
    const result = await this.request(`media/search?${params}`, z.array(mpMediaSchema), { signal });
    return result.map(normalizeMedia);
  }

  searchMikan(
    query: { keyword: string; group?: string },
    signal?: AbortSignal,
  ): Promise<MikanPage> {
    return this.envelope("plugin/PiAgentBridge/mikan_search", mikanPageSchema, {
      method: "POST",
      body: query,
      signal,
    });
  }

  async searchResources(
    media: Media,
    criteria: Criteria,
    signal?: AbortSignal,
  ): Promise<Resource[]> {
    const params = new URLSearchParams({ mtype: media.type, title: media.title, year: media.year });
    if (criteria.season) {
      params.set("season", String(criteria.season));
    }
    const contexts = await this.envelope(
      `search/media/${encodeURIComponent(media.key)}?${params}`,
      z.array(mpContextSchema),
      { signal },
    );
    return contexts
      .map((context) => normalizeResource(context, media))
      .filter((resource) => resource !== undefined);
  }

  getDownloading(signal?: AbortSignal): Promise<ActiveDownload[]> {
    return this.request("download/", z.array(activeDownloadSchema), { signal });
  }

  getDownloadStates(hashes: string[], signal?: AbortSignal): Promise<DownloadResult[]> {
    const schema = z.array(
      z.object({ hash: z.string(), progress: z.number(), completed: z.boolean() }),
    );
    return this.envelope("plugin/PiAgentBridge/download_states", schema, {
      method: "POST",
      body: { hashes, downloader: this.options.downloader },
      signal,
    });
  }

  async submitDownload(media: Media, resource: Resource, signal?: AbortSignal): Promise<string> {
    const result = await this.envelope("download/", z.object({ download_id: z.string().min(1) }), {
      method: "POST",
      body: {
        media_in: media.raw,
        torrent_in: resource.torrent,
        downloader: this.options.downloader,
        save_path: this.options.savePath,
      },
      signal,
      mutation: true,
    });
    return result.download_id;
  }

  resolveLinks(links: string[], signal?: AbortSignal): Promise<ResolvedLink[]> {
    const schema = z.array(
      z.object({ magnet: z.string(), infoHash: z.string().regex(/^[a-f0-9]{40}$/) }),
    );
    return this.envelope("plugin/PiAgentBridge/resolve_links", schema, {
      method: "POST",
      body: { links },
      signal,
    });
  }

  async submit115(links: string[], signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + 120_000;
    while (true) {
      const response = await this.request(
        "plugin/CloudAutoSearch/manual_submit",
        mpEnvelopeSchema,
        {
          method: "POST",
          body: { links: links.join("\n"), force: false },
          signal,
          mutation: true,
        },
      );
      if (response.success) {
        return this.parseResponse(z.object({ id: z.string().min(1) }), response.data, true).id;
      }
      if (response.message !== "已有任务在运行，请稍后重试") {
        throw this.rejection(response.message);
      }
      // The backend explicitly rejected this request before starting a job.
      // Only that response permits another attempt; uncertain writes propagate.
      if (Date.now() >= deadline) {
        throw new BackendBusyError();
      }
      try {
        await delay(2_000, undefined, { signal });
      } catch (error) {
        if (signal?.aborted) {
          throw new BackendBusyError();
        }
        throw error;
      }
    }
  }

  get115Submission(signal?: AbortSignal): Promise<OfflineSubmission> {
    return this.envelope("plugin/CloudAutoSearch/manual_status", submissionSchema, { signal });
  }

  get115Status(refresh: boolean, signal?: AbortSignal): Promise<OfflinePluginStatus> {
    return this.envelope(
      refresh ? "plugin/CloudAutoSearch/check_login" : "plugin/CloudAutoSearch/status",
      offlinePluginStatusSchema,
      refresh ? { method: "POST", body: {}, signal } : { signal },
    );
  }

  async get115Tasks(signal?: AbortSignal): Promise<OfflineTask[]> {
    const response = await this.request(
      "plugin/P115StrmHelper/offline_tasks",
      z.object({ code: z.number(), data: z.object({ tasks: z.array(offlineTaskSchema) }) }),
      {
        method: "POST",
        body: { page: 1, limit: -1 },
        signal,
      },
    );
    if (response.code !== 0) {
      throw new BackendRejectedError("115 离线任务查询失败");
    }
    return response.data.tasks;
  }

  async checkLibrary(
    media: Media,
    criteria: Criteria,
    signal?: AbortSignal,
  ): Promise<LibraryResult> {
    const body = { ...media.raw, season: criteria.season };
    const missing = await this.request(
      "mediaserver/notexists",
      z.array(z.object({}).passthrough()),
      { method: "POST", body, signal },
    );
    const episodes =
      media.type === "电视剧"
        ? await this.request(
            "mediaserver/exists_remote",
            z.record(z.string(), z.array(z.number())),
            { method: "POST", body, signal },
          )
        : undefined;
    const existingEpisodes = criteria.season
      ? (episodes?.[String(criteria.season)] ?? [])
      : Object.values(episodes ?? {}).flat();
    const exists = criteria.episodes?.length
      ? criteria.episodes.every((episode) => existingEpisodes.includes(episode))
      : missing.length === 0;
    if (!exists) {
      return { exists, episodes };
    }
    const params = new URLSearchParams({ title: media.title, year: media.year, mtype: media.type });
    if (media.raw.tmdb_id !== null) {
      params.set("tmdbid", String(media.raw.tmdb_id));
    }
    if (criteria.season) {
      params.set("season", String(criteria.season));
    }
    const local = await this.request(
      `mediaserver/exists?${params}`,
      z.object({
        success: z.boolean(),
        data: z.object({ item: z.object({ id: z.string().optional() }) }),
      }),
      { signal },
    );
    if (!local.data.item.id) {
      return { exists, episodes };
    }
    const play = await this.request(
      `mediaserver/play/${encodeURIComponent(local.data.item.id)}`,
      mpEnvelopeSchema,
      { signal },
    );
    const playUrl = play.success
      ? z.object({ url: z.string().url() }).parse(play.data).url
      : undefined;
    return { exists, episodes, playUrl };
  }

  async getTransferHistory(media: Media, signal?: AbortSignal): Promise<TransferHistory[]> {
    const params = new URLSearchParams({ title: media.title, count: "100" });
    const result = await this.envelope(
      `history/transfer?${params}`,
      z.object({ list: z.array(transferHistorySchema) }),
      { signal },
    );
    return result.list;
  }

  async listTransferFailures(query: TransferQuery, signal?: AbortSignal): Promise<TransferPage> {
    const params = new URLSearchParams({
      page: String(query.page),
      count: String(query.count),
      status: "false",
    });
    if (query.title) {
      params.set("title", query.title);
    }
    const recordSchema = z.object({
      id: z.number().int().positive(),
      src: z.string(),
      title: z.string().nullable(),
      errmsg: z.string().nullable(),
      date: z.string(),
      status: z.literal(false),
    });
    const page = await this.envelope(
      `history/transfer?${params}`,
      z.object({ total: z.number().int().nonnegative(), list: z.array(recordSchema) }),
      { signal },
    );
    return {
      ...query,
      total: page.total,
      items: page.list.map((item) => ({
        id: String(item.id),
        filename: basename(item.src),
        title: item.title ?? "",
        error: item.errmsg ?? "",
        date: item.date,
      })),
    };
  }

  getTransferRecord(id: string, signal?: AbortSignal): Promise<TransferRecord> {
    return this.envelope(`plugin/PiAgentBridge/transfer_history/${id}`, transferRecordSchema, {
      signal,
    });
  }

  private transferBody(command: TransferCommand) {
    const identification = command.identification;
    return {
      history_id: Number(command.historyId),
      revision: command.revision,
      identification: identification
        ? {
            source: identification.media.source,
            id: identification.media.id,
            type: identification.media.type,
            season: identification.season,
            episodes: identification.episodes,
          }
        : undefined,
    };
  }

  previewTransfer(command: TransferCommand, signal?: AbortSignal): Promise<TransferPlan> {
    return this.envelope("plugin/PiAgentBridge/transfer_retry/preview", transferPlanSchema, {
      method: "POST",
      body: this.transferBody(command),
      signal,
    });
  }

  async retryTransfer(
    command: TransferCommand,
    planHash: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await this.envelope(
      "plugin/PiAgentBridge/transfer_retry",
      z.object({ completed: z.boolean() }),
      {
        method: "POST",
        body: { ...this.transferBody(command), plan_hash: planHash },
        signal,
        mutation: true,
      },
    );
    return result.completed;
  }

  listSubscriptions(signal?: AbortSignal): Promise<Subscription[]> {
    return this.request("subscribe/", z.array(subscriptionSchema), { signal });
  }

  async subscribe(media: Media, season: number | undefined, signal?: AbortSignal): Promise<string> {
    const result = await this.envelope("subscribe/", z.object({ id: z.number().positive() }), {
      method: "POST",
      body: {
        name: media.title,
        year: media.year,
        type: media.type,
        media_source: media.source,
        media_id: media.id,
        season,
      },
      signal,
      mutation: true,
    });
    return String(result.id);
  }

  async changeSubscription(
    id: string,
    operation: "pause" | "resume" | "delete",
    signal?: AbortSignal,
  ): Promise<void> {
    const path =
      operation === "delete"
        ? `subscribe/${id}`
        : `subscribe/status/${id}?state=${operation === "pause" ? "P" : "R"}`;
    await this.envelope(path, z.unknown(), {
      method: operation === "delete" ? "DELETE" : "PUT",
      signal,
      mutation: true,
    });
  }
}
