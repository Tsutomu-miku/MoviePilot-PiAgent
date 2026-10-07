import { useId, useState, type FormEvent } from "react";
import { mikanQuerySchema, type MikanQuery } from "@mp-pi/contracts";

export function MikanSearchForm({
  initial,
  disabled,
  onSubmit,
}: {
  initial?: MikanQuery;
  disabled: boolean;
  onSubmit(query: MikanQuery): void;
}) {
  const [error, setError] = useState("");
  const formId = useId();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const result = mikanQuerySchema.safeParse(
      Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "")),
    );
    if (!result.success) {
      setError("请填写动画关键词，并检查筛选条件。");
      return;
    }
    setError("");
    onSubmit(result.data);
  }
  return (
    <form className="mikan-search-form" onSubmit={submit}>
      <fieldset disabled={disabled}>
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor={`${formId}-keyword`}>动画关键词</label>
            <input
              id={`${formId}-keyword`}
              name="keyword"
              defaultValue={initial?.keyword}
              maxLength={120}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${formId}-group`}>字幕组</label>
            <input
              id={`${formId}-group`}
              name="group"
              defaultValue={initial?.group}
              maxLength={120}
              placeholder="不限"
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${formId}-resolution`}>分辨率</label>
            <select
              id={`${formId}-resolution`}
              name="resolution"
              defaultValue={initial?.resolution ?? ""}
            >
              <option value="">不限</option>
              {["2160p", "1080p", "1080i", "720p"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor={`${formId}-subtitle`}>字幕</label>
            <select
              id={`${formId}-subtitle`}
              name="subtitle"
              defaultValue={initial?.subtitle ?? ""}
            >
              <option value="">不限</option>
              {["CHS", "CHT", "JP", "EN"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </div>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit">
          搜索蜜柑
        </button>
      </fieldset>
    </form>
  );
}
