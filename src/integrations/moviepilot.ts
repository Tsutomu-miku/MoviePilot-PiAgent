export interface DownloadStatusBackend {
  getDownloading(signal?: AbortSignal): Promise<unknown[]>;
}

export class MoviePilotClient implements DownloadStatusBackend {
  private readonly base: URL;

  constructor(baseUrl: string, private readonly token: string, private readonly request = fetch) {
    this.base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    if (!["http:", "https:"].includes(this.base.protocol) || this.base.username || this.base.password ||
        this.base.search || this.base.hash || !token.trim()) {
      throw new Error("MoviePilot requires an HTTP(S) API URL and access token");
    }
  }

  async getDownloading(signal?: AbortSignal): Promise<unknown[]> {
    const timeout = AbortSignal.timeout(15_000);
    const response = await this.request(new URL("download/", this.base), {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`MoviePilot returned HTTP ${response.status}`);
    const result: unknown = await response.json();
    if (!Array.isArray(result)) throw new Error("Unexpected MoviePilot download response");
    return result;
  }
}
