import { AppError } from "../core/errors.js";

export function magnetHash(link: string): string | undefined {
  if (!/^magnet:\?/i.test(link)) {
    return undefined;
  }
  const hash = new URL(link).searchParams
    .getAll("xt")
    .find((xt) => xt.startsWith("urn:btih:"))
    ?.slice(9);
  if (!hash) {
    throw new AppError("INVALID_MAGNET", "磁力链接缺少 BTIH");
  }
  if (/^[0-9a-f]{40}$/i.test(hash)) {
    return hash.toLowerCase();
  }
  if (!/^[a-z2-7]{32}$/i.test(hash)) {
    throw new AppError("INVALID_MAGNET", "磁力链接的 BTIH 格式错误");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...hash.toUpperCase()]
    .map((character) => alphabet.indexOf(character).toString(2).padStart(5, "0"))
    .join("");
  return Array.from({ length: 20 }, (_, index) =>
    parseInt(bits.slice(index * 8, index * 8 + 8), 2)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
}

export function parseLinks(text: string): string[] {
  const links = [...new Set(text.trim().split(/\s+/).filter(Boolean))];
  if (links.length === 0 || links.length > 20) {
    throw new AppError("LINK_LIMIT", "一次可推送 1–20 个链接");
  }
  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new AppError("INVALID_LINK", "请输入完整磁力链接或种子下载链接");
    }
    if (url.protocol === "magnet:") {
      magnetHash(link);
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new AppError("INVALID_LINK", "只支持磁力链接和 HTTP(S) 种子链接");
    }
  }
  return links;
}
