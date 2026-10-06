import { useId, useState, type FormEvent } from "react";
import { criteriaSchema, type Criteria } from "@mp-pi/contracts";

interface Props {
  initial: Criteria;
  onSubmit(value: Criteria): void;
  submitLabel: string;
  showSeason?: boolean;
  disabled?: boolean;
}

const fields = [
  { key: "resolution", label: "分辨率", options: ["2160p", "1080p", "1080i", "720p"] },
  { key: "channels", label: "声道", options: ["2.0", "5.1", "7.1"] },
  {
    key: "audio",
    label: "音频",
    options: ["Atmos", "TrueHD", "DTS-HD", "DTS", "DDP", "AC3", "AAC", "FLAC"],
  },
  { key: "subtitle", label: "字幕", options: ["CHS", "CHT", "JP", "EN"] },
  { key: "source", label: "片源", options: ["WEB-DL", "WEBRip", "Remux", "BluRay", "HDTV"] },
  { key: "preferResolution", label: "优先排序", options: ["2160p", "1080p", "1080i", "720p"] },
] as const;

export function CriteriaForm({
  initial,
  onSubmit,
  submitLabel,
  showSeason = false,
  disabled = false,
}: Props) {
  const [error, setError] = useState("");
  const formId = useId();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values: Record<string, unknown> = {};
    for (const field of fields) {
      const value = form.get(field.key);
      if (value) {
        values[field.key] = value;
      }
    }
    for (const key of ["maxSizeGiB", "minSeeders", "season"] as const) {
      const value = form.get(key);
      if (value) {
        values[key] = Number(value);
      }
    }
    values.noDolbyVision = form.has("noDolbyVision");
    values.noHdr = form.has("noHdr");
    const exclude = String(form.get("exclude") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (exclude.length > 0) {
      values.exclude = exclude;
    }
    const episodes = String(form.get("episodes") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (episodes.length > 0) {
      values.episodes = episodes.map(Number);
    }
    const parsed = criteriaSchema.safeParse(values);
    if (!parsed.success) {
      setError("请检查容量、做种数、季号和集数；数值应为有效的正数。");
      return;
    }
    setError("");
    onSubmit(parsed.data);
  }
  return (
    <form className="criteria-form" onSubmit={submit}>
      <fieldset disabled={disabled}>
        <div className="form-grid">
          {fields.map((field) => (
            <div className="form-field" key={field.key}>
              <label htmlFor={`${formId}-${field.key}`}>{field.label}</label>
              <select
                id={`${formId}-${field.key}`}
                name={field.key}
                defaultValue={initial[field.key] ?? ""}
              >
                <option value="">不限</option>
                {field.options.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </div>
          ))}
          <label>
            最大容量 GiB
            <input
              name="maxSizeGiB"
              type="number"
              min="0.1"
              step="0.1"
              defaultValue={initial.maxSizeGiB}
            />
          </label>
          <label>
            最少做种数
            <input
              name="minSeeders"
              type="number"
              min="0"
              step="1"
              defaultValue={initial.minSeeders}
            />
          </label>
          {showSeason && (
            <>
              <label>
                季号
                <input
                  name="season"
                  type="number"
                  min="1"
                  max="100"
                  defaultValue={initial.season}
                />
              </label>
              <label>
                集数（逗号分隔）
                <input
                  name="episodes"
                  defaultValue={initial.episodes?.join(",")}
                  placeholder="1,2,3"
                />
              </label>
            </>
          )}
          <label className="wide">
            排除关键词（逗号分隔）
            <input name="exclude" defaultValue={initial.exclude?.join(",")} />
          </label>
        </div>
        <div className="check-row">
          <label>
            <input name="noDolbyVision" type="checkbox" defaultChecked={initial.noDolbyVision} />{" "}
            排除 Dolby Vision
          </label>
          <label>
            <input name="noHdr" type="checkbox" defaultChecked={initial.noHdr} /> 排除 HDR
          </label>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" type="submit">
          {submitLabel}
        </button>
      </fieldset>
    </form>
  );
}
