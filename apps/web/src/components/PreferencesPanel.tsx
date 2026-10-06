import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Destination, Preferences } from "@mp-pi/contracts";
import { ApiClient } from "../api";
import { CriteriaForm } from "./CriteriaForm";

export function PreferencesPanel({ api }: { api: ApiClient }) {
  const client = useQueryClient();
  const preferences = useQuery({ queryKey: ["preferences"], queryFn: () => api.preferences() });
  const [destination, setDestination] = useState<Destination | "" | undefined>();
  const [message, setMessage] = useState("");
  const save = useMutation({
    mutationFn: (value: Preferences) => api.savePreferences(value),
    onSuccess: (saved) => {
      client.setQueryData(["preferences"], saved);
      setDestination(undefined);
      setMessage("偏好已保存，新搜索会使用这些默认条件。");
    },
  });
  if (preferences.isPending) {
    return <p>正在加载偏好…</p>;
  }
  if (preferences.error) {
    return (
      <p role="alert" className="error">
        {preferences.error.message}
      </p>
    );
  }
  const value = preferences.data!;
  return (
    <section className="content-panel">
      <h2>长期偏好</h2>
      <p className="muted">新搜索使用这些默认条件。对话中只说“本次要 4K”不会改变长期偏好。</p>
      <label>
        默认目的地
        <select
          aria-label="默认目的地"
          value={destination ?? value.destination ?? ""}
          onChange={(event) => setDestination(event.target.value as Destination | "")}
        >
          <option value="">每次选择</option>
          <option value="moviepilot">MoviePilot 下载器</option>
          <option value="115">115 网盘</option>
        </select>
      </label>
      <CriteriaForm
        key={JSON.stringify(value)}
        initial={value}
        submitLabel="保存偏好"
        disabled={save.isPending}
        onSubmit={(criteria) =>
          save.mutate({ ...criteria, destination: (destination ?? value.destination) || undefined })
        }
      />
      <button
        disabled={save.isPending}
        onClick={() => {
          setDestination("");
          save.mutate({});
        }}
      >
        清除全部偏好
      </button>
      {message && <p role="status">{message}</p>}
      {save.error && (
        <p role="alert" className="error">
          {save.error.message}
        </p>
      )}
    </section>
  );
}
