import { randomUUID } from "node:crypto";
import type { Criteria, Media, Resource } from "./types.js";
import type { MpContext, MpMedia } from "../integrations/moviepilot-contracts.js";
import { magnetHash } from "./links.js";

export function normalizeMedia(raw: MpMedia): Media {
  return {
    key: `${raw.source}:${raw.media_id}`,
    source: raw.source,
    id: raw.media_id,
    title: raw.title,
    year: raw.year,
    type: raw.type,
    overview: raw.overview.slice(0, 500),
    raw,
  };
}

export function extractTags(title: string, meta: MpContext["meta_info"]): Resource["tags"] {
  const text = title;
  const resolutions: Array<[string, RegExp]> = [
    ["1080i", /1080i/i],
    ["2160p", /2160p|\b4k\b|\buhd\b/i],
    ["1080p", /1080p/i],
    ["720p", /720p/i],
  ];
  const resolution = resolutions.find(([, pattern]) => pattern.test(text))?.[0];
  const audio = ["Atmos", "TrueHD", "DTS-HD", "DTS", "DDP", "AC3", "AAC", "FLAC"].filter((tag) => {
    const pattern =
      tag === "DDP"
        ? /\bDDP(?:\b|(?=\d))|E[ .-]?AC[ .-]?3/i
        : new RegExp(tag.replace("-", "[ .-]?"), "i");
    return pattern.test(text);
  });
  const channels =
    text.match(/(?:^|[^\d])([12567][ .]1)(?:[^\d]|$)/)?.[1]?.replace(" ", ".") ??
    (/\b2[ .]0\b/.test(text) ? "2.0" : undefined);
  const subtitles: string[] = [];
  if (/\bCHS\b|\bSC\b|简体|简中|简繁|中字|中文字幕/i.test(text)) {
    subtitles.push("CHS");
  }
  if (/\bCHT\b|\bTC\b|繁体|繁中|简繁/i.test(text)) {
    subtitles.push("CHT");
  }
  if (/\bJPN?\b|日语字幕|日文字幕/i.test(text)) {
    subtitles.push("JP");
  }
  if (/\bENG?\b|英文字幕/i.test(text)) {
    subtitles.push("EN");
  }
  const sources: Array<[string, RegExp]> = [
    ["WEB-DL", /WEB[ .-]?DL/i],
    ["WEBRip", /WEB[ .-]?Rip/i],
    ["Remux", /Remux/i],
    ["BluRay", /Blu[ .-]?Ray|BDRip/i],
    ["HDTV", /HDTV/i],
  ];
  const source = sources.find(([, pattern]) => pattern.test(text))?.[0];
  const season = Number(meta.begin_season ?? title.match(/S(\d{1,2})(?:E|\b)/i)?.[1]) || undefined;
  const match = title.match(/S\d{1,2}E(\d{1,3})(?:[ .-]?(?:E)?(\d{1,3}))?/i);
  const begin = Number(meta.begin_episode ?? match?.[1]);
  const end = Number(meta.end_episode ?? match?.[2] ?? begin);
  const episodes =
    begin > 0 && end >= begin && end - begin < 1000
      ? Array.from({ length: end - begin + 1 }, (_, i) => begin + i)
      : undefined;
  return {
    resolution,
    channels,
    audio,
    subtitles,
    source,
    season,
    episodes,
    dolbyVision: /\bDV\b|Dolby[ .-]?Vision|杜比视界/i.test(text),
    hdr: /\bHDR(?:10\+?)?\b/i.test(text),
  };
}

export function normalizeResource(context: MpContext, media: Media): Resource | undefined {
  if (context.media_info && normalizeMedia(context.media_info).key !== media.key) {
    return undefined;
  }
  const torrent = context.torrent_info;
  const tags = extractTags(`${torrent.title} ${torrent.description}`, context.meta_info);
  return {
    id: randomUUID(),
    title: torrent.title,
    site: torrent.site_name,
    sizeGiB: Math.round((torrent.size / 2 ** 30) * 100) / 100,
    seeders: torrent.seeders ?? 0,
    tags,
    torrent,
    infoHash:
      torrent.enclosure && /^magnet:\?/i.test(torrent.enclosure)
        ? magnetHash(torrent.enclosure)
        : undefined,
  };
}

export function filterResources(resources: Resource[], criteria: Criteria): Resource[] {
  const matched = resources.filter((item) => {
    const tags = item.tags;
    return (
      (!criteria.resolution || tags.resolution === criteria.resolution) &&
      (!criteria.channels || tags.channels === criteria.channels) &&
      (!criteria.audio ||
        tags.audio.some((audio) => audio.toLowerCase() === criteria.audio?.toLowerCase())) &&
      (!criteria.subtitle || tags.subtitles.includes(criteria.subtitle.toUpperCase())) &&
      (!criteria.source || tags.source?.toLowerCase() === criteria.source.toLowerCase()) &&
      (!criteria.maxSizeGiB ||
        (item.torrent.size > 0 && item.torrent.size <= criteria.maxSizeGiB * 2 ** 30)) &&
      (criteria.minSeeders == null || item.seeders >= criteria.minSeeders) &&
      (!criteria.noDolbyVision || !tags.dolbyVision) &&
      (!criteria.noHdr || !tags.hdr) &&
      (!criteria.season || tags.season === criteria.season) &&
      (!criteria.episodes?.length ||
        criteria.episodes.every((episode) => tags.episodes?.includes(episode))) &&
      !criteria.exclude?.some((word) => item.title.toLowerCase().includes(word.toLowerCase()))
    );
  });
  return matched.sort((a, b) => {
    const score = (r: Resource) =>
      (r.tags.resolution === criteria.preferResolution ? 1000 : 0) + Math.log2(r.seeders + 1) * 10;
    return score(b) - score(a) || a.id.localeCompare(b.id);
  });
}
