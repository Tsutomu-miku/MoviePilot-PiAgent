import { test } from "node:test";
import assert from "node:assert/strict";
import { resource } from "./fixtures.js";
import { extractTags, filterResources } from "../src/domain/resources.js";
import { magnetHash, parseLinks } from "../src/domain/links.js";
import { publicResource } from "../src/domain/types.js";

test("resolution, channels and audio are independent hard conditions, including 1080i", () => {
  const resources = [
    resource("Movie.1080i.DTS5.1", 1),
    resource("Movie.1080p.DDP5.1", 2),
    resource("Movie.2160p.TrueHD7.1.Atmos.DV.HDR", 3),
  ];
  assert.equal(
    filterResources(resources, { resolution: "1080p", channels: "5.1", audio: "DDP" })[0]?.id,
    resources[1]?.id,
  );
  assert.equal(filterResources(resources, { resolution: "1080p", audio: "DTS" }).length, 0);
  assert.equal(filterResources(resources, { resolution: "2160p", noDolbyVision: true }).length, 0);
  assert.equal(extractTags("S02E01-E03.1080p.AAC2.0.CHT", {}).episodes?.length, 3);
});

test("all resources are filtered before pagination; a candidate after index 50 remains selectable", () => {
  const resources = Array.from({ length: 60 }, (_, i) =>
    resource(`Movie.${i < 59 ? "720p" : "2160p"}.DDP5.1`, i + 1),
  );
  assert.equal(filterResources(resources, { resolution: "2160p" }).length, 1);
  assert.equal(filterResources(resources, { resolution: "2160p" })[0]?.id, resources[59]?.id);
});

test("hard size, episodes, seeders and exclusion conditions do not accept unknown metadata", () => {
  const known = resource("Show.S01E01-E03.2160p.DDP5.1.CHS");
  const unknown = resource("Show.Unknown");
  unknown.torrent.size = 0;
  assert.deepEqual(
    filterResources([known, unknown], {
      maxSizeGiB: 15,
      minSeeders: 1,
      season: 1,
      episodes: [1, 3],
      exclude: ["Unknown"],
    }).map((item) => item.id),
    [known.id],
  );
});

test("public resource views strip all private backend fields", () => {
  const result = JSON.stringify(publicResource(resource("Movie.2160p")));
  assert.doesNotMatch(result, /site_cookie|private-tracker-cookie|enclosure|magnet:/);
});

test("magnet parsing supports hex, Base32 and deduped pasted links while rejecting invalid inputs", () => {
  assert.equal(magnetHash(`magnet:?xt=urn:btih:${"A".repeat(40)}`), "a".repeat(40));
  assert.equal(magnetHash(`magnet:?xt=urn:btih:${"A".repeat(32)}`), "0".repeat(40));
  const link = `magnet:?xt=urn:btih:${"b".repeat(40)}`;
  assert.deepEqual(parseLinks(`${link}\n${link}`), [link]);
  assert.throws(() => parseLinks(""), /1–20/);
  assert.throws(() => parseLinks("https://user:password@example.test/torrent"), /只支持/);
  assert.throws(() => parseLinks("magnet:?dn=invalid"), /BTIH/);
});
