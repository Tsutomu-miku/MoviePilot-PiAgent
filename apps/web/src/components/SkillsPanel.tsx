import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SkillDetail, SkillSummary, SkillWrite } from "@mp-pi/contracts";
import { ApiClient } from "../api";

const template = `---
name: my-skill
description: 描述这个技能处理什么任务，以及什么时候使用。
---

在这里填写操作说明，可以引用已有的业务工具。
`;

function SkillEditor({
  initial,
  saving,
  onSave,
}: {
  initial?: SkillDetail;
  saving: boolean;
  onSave(name: string, value: SkillWrite): void;
}) {
  const [name, setName] = useState(initial?.name ?? "my-skill");
  const [content, setContent] = useState(initial?.content ?? template);
  const formId = useId();
  function submit(event: FormEvent) {
    event.preventDefault();
    onSave(name, { content, enabled: initial?.enabled ?? true });
  }
  return (
    <form className="skill-editor" onSubmit={submit}>
      <div className="form-field">
        <label htmlFor={`${formId}-name`}>技能名称</label>
        <input
          id={`${formId}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={Boolean(initial)}
          pattern="[a-z](?:[a-z0-9]|-){0,63}"
          required
        />
      </div>
      <p className="muted">使用英文小写字母、数字和连字符，并与下方 name 保持一致。</p>
      <div className="form-field">
        <label htmlFor={`${formId}-content`}>技能内容（SKILL.md）</label>
        <textarea
          id={`${formId}-content`}
          className="skill-content"
          rows={20}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          required
        />
      </div>
      {!initial && <p className="muted">新技能保存后会启用，可在列表中随时停用。</p>}
      {initial?.source === "builtin" && (
        <p className="muted">保存后成为你的个人版本，插件更新不会覆盖。</p>
      )}
      <button className="primary" disabled={saving} type="submit">
        {saving ? "保存中…" : "保存技能"}
      </button>
    </form>
  );
}

export function SkillsPanel({
  api,
  onUse,
  onDisable,
}: {
  api: ApiClient;
  onUse(skill: SkillSummary): void;
  onDisable(name: string): void;
}) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const skills = useQuery({ queryKey: ["skills"], queryFn: () => api.skills() });
  const detail = useQuery({
    queryKey: ["skill", selected],
    queryFn: () => api.skill(selected!),
    enabled: Boolean(selected),
  });
  const save = useMutation({
    mutationFn: ({ name, value }: { name: string; value: SkillWrite }) =>
      api.saveSkill(name, value),
    onSuccess: async (skill) => {
      client.setQueryData(["skill", skill.name], skill);
      setSelected(skill.name);
      setCreating(false);
      setMessage("技能已保存，下次对话会使用更新后的说明。");
      if (!skill.enabled) {
        onDisable(skill.name);
      }
      await client.invalidateQueries({ queryKey: ["skills"] });
    },
  });
  const activate = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      api.activateSkill(name, enabled),
    onSuccess: async (skill) => {
      if (!skill.enabled) {
        onDisable(skill.name);
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: ["skills"] }),
        client.invalidateQueries({ queryKey: ["skill", skill.name] }),
      ]);
    },
  });
  return (
    <section className="content-panel skills-panel">
      <div className="section-heading">
        <h2>技能</h2>
        <button
          onClick={() => {
            setSelected(undefined);
            setCreating(true);
            setMessage("");
          }}
        >
          新建个人技能
        </button>
      </div>
      <p className="muted">
        个人技能保存在你的 MP 数据目录。启用后，Agent 可以按需读取，也可以在对话中明确选择使用。
      </p>
      {[skills.error, detail.error, save.error, activate.error]
        .filter(Boolean)
        .map((error, index) => (
          <p className="error" role="alert" key={index}>
            {error?.message}
          </p>
        ))}
      {message && <p role="status">{message}</p>}
      {skills.isPending && <p>正在加载技能…</p>}
      <div className="skill-list">
        {skills.data?.map((skill) => (
          <article className="media-card" key={skill.name}>
            <div className="section-heading">
              <strong>{skill.name}</strong>
              <span className="status">{skill.source === "personal" ? "个人" : "内置"}</span>
            </div>
            <p>{skill.description}</p>
            <label className="skill-activation">
              <input
                type="checkbox"
                aria-label={`启用 ${skill.name}`}
                checked={skill.enabled}
                disabled={activate.isPending}
                onChange={(event) =>
                  activate.mutate({ name: skill.name, enabled: event.target.checked })
                }
              />
              {skill.enabled ? "已启用" : "已停用"}
            </label>
            <div className="button-row">
              <button
                onClick={() => {
                  setSelected(skill.name);
                  setCreating(false);
                  setMessage("");
                }}
              >
                查看与编辑
              </button>
              <button disabled={!skill.enabled} onClick={() => onUse(skill)}>
                在对话中使用
              </button>
            </div>
          </article>
        ))}
      </div>
      {selected && detail.isPending && <p>正在加载技能内容…</p>}
      {(creating || detail.data) && (
        <SkillEditor
          key={selected ?? "new"}
          initial={creating ? undefined : detail.data}
          saving={save.isPending}
          onSave={(name, value) => save.mutate({ name, value })}
        />
      )}
    </section>
  );
}
