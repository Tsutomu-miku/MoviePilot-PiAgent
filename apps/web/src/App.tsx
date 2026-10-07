import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UserAction, SkillSummary } from "@mp-pi/contracts";
import { ApiClient } from "./api";
import { useChat } from "./hooks/useChat";
import { Chat } from "./components/Chat";
import { TaskList } from "./components/TaskList";
import { PreferencesPanel } from "./components/PreferencesPanel";
import { SkillsPanel } from "./components/SkillsPanel";

type Tab = "chat" | "tasks" | "preferences" | "skills";
const headings: Record<Tab, { title: string; description: string }> = {
  chat: { title: "对话", description: "继续补充条件，保持在同一会话中" },
  tasks: { title: "任务", description: "依据后端进度和媒体库更新" },
  preferences: { title: "偏好", description: "明确保存的默认要求" },
  skills: { title: "技能", description: "查看、编辑和启用你的个人操作说明" },
};

function Login({ onLogin }: { onLogin(token: string): void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await new ApiClient(token).conversations();
      onLogin(token);
    } catch (error) {
      setError(error instanceof Error ? error.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="brand-mark">π</div>
        <h1>MoviePilot Pi Agent</h1>
        <p className="muted">一个会话，持续处理你的媒体请求。</p>
        <label>
          访问令牌
          <input
            autoFocus
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required
          />
        </label>
        <button className="primary" disabled={busy} type="submit">
          {busy ? "正在登录…" : "进入"}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}

function Workspace({ token, onLogout }: { token: string; onLogout?(): void }) {
  const api = useMemo(() => new ApiClient(token), [token]);
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>();
  const [tab, setTab] = useState<Tab>("chat");
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary>();
  const chat = useChat(api);
  const conversations = useQuery({
    queryKey: ["conversations"],
    queryFn: () => api.conversations(),
  });
  const tasks = useQuery({
    queryKey: ["tasks"],
    queryFn: () => api.tasks(),
    refetchInterval: 5000,
  });
  const create = useMutation({
    mutationFn: () => api.createConversation(),
    onSuccess: async (conversation) => {
      setSelectedId(conversation.id);
      setTab("chat");
      await client.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
  const refresh = useMutation({
    mutationFn: () => api.refreshTasks(),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const activeId = selectedId ?? conversations.data?.[0]?.id;
  const active = conversations.data?.find((item) => item.id === activeId);
  const action = (value: UserAction, label: string, conversationId: string) => {
    setSelectedId(conversationId);
    setTab("chat");
    void chat.send(conversationId, label, value);
  };
  const pendingCount =
    tasks.data?.filter((task) => task.state === "awaiting_confirmation").length ?? 0;
  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">π</span>
          <div>
            <strong>Pi Agent</strong>
            <small>MoviePilot</small>
          </div>
        </div>
        <button
          className="new-conversation"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          ＋ 新建会话
        </button>
        <nav aria-label="功能">
          <button className={tab === "chat" ? "selected" : ""} onClick={() => setTab("chat")}>
            对话
          </button>
          <button className={tab === "tasks" ? "selected" : ""} onClick={() => setTab("tasks")}>
            任务 {pendingCount > 0 && <span className="badge">{pendingCount}</span>}
          </button>
          <button
            className={tab === "preferences" ? "selected" : ""}
            onClick={() => setTab("preferences")}
          >
            偏好
          </button>
          <button className={tab === "skills" ? "selected" : ""} onClick={() => setTab("skills")}>
            技能
          </button>
        </nav>
        <p className="sidebar-label">会话</p>
        <div className="conversation-list">
          {conversations.data?.map((item) => (
            <button
              className={activeId === item.id ? "selected" : ""}
              key={item.id}
              title={item.id}
              onClick={() => {
                setSelectedId(item.id);
                setTab("chat");
              }}
            >
              {item.title}
              <small>{new Date(item.updatedAt).toLocaleDateString()}</small>
            </button>
          ))}
        </div>
        {onLogout && (
          <button className="logout" onClick={onLogout}>
            退出登录
          </button>
        )}
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <h1>{tab === "chat" ? (active?.title ?? "对话") : headings[tab].title}</h1>
            <p>{headings[tab].description}</p>
          </div>
          <span className="connection">● 个人工作区</span>
        </header>
        {[conversations.error, create.error, refresh.error].filter(Boolean).map((error, index) => (
          <p className="error global-error" role="alert" key={index}>
            {error?.message}
          </p>
        ))}
        {chat.error && (
          <p role="alert" className="error global-error">
            {chat.error}
          </p>
        )}
        {tab === "chat" &&
          (activeId ? (
            <Chat
              key={activeId}
              conversationId={activeId}
              api={api}
              pending={chat.pending}
              selectedSkill={selectedSkill?.name}
              onClearSkill={() => setSelectedSkill(undefined)}
              onSend={(text, value) => {
                void chat.send(activeId, text, value, value ? undefined : selectedSkill?.name);
              }}
            />
          ) : (
            <div className="empty-state">
              <h2>开始一个会话</h2>
              <p>网页和飞书都可以继续同一个会话。</p>
              <button className="primary" onClick={() => create.mutate()}>
                新建会话
              </button>
            </div>
          ))}
        {tab === "tasks" && (
          <section className="content-panel">
            <div className="section-heading">
              <h2>全部任务</h2>
              <button disabled={refresh.isPending} onClick={() => refresh.mutate()}>
                {refresh.isPending ? "更新中…" : "核对后端状态"}
              </button>
            </div>
            <div className="status-summary">
              <span>待确认 {pendingCount}</span>
              <span>
                进行中{" "}
                {tasks.data?.filter((task) =>
                  ["submitted", "submitting", "downloading"].includes(task.state),
                ).length ?? 0}
              </span>
              <span>
                已入库 {tasks.data?.filter((task) => task.state === "imported").length ?? 0}
              </span>
            </div>
            {tasks.error && (
              <p className="error" role="alert">
                {tasks.error.message}
              </p>
            )}
            <TaskList items={tasks.data ?? []} busy={chat.pending.length > 0} onAction={action} />
          </section>
        )}
        {tab === "preferences" && <PreferencesPanel api={api} />}
        {tab === "skills" && (
          <SkillsPanel
            api={api}
            onUse={(skill) => {
              setSelectedSkill(skill);
              setTab("chat");
              if (!activeId) {
                create.mutate();
              }
            }}
            onDisable={(name) => {
              if (selectedSkill?.name === name) {
                setSelectedSkill(undefined);
              }
            }}
          />
        )}
      </main>
    </div>
  );
}

export function App() {
  const client = useQueryClient();
  const [token, setToken] = useState(() => sessionStorage.getItem("pi-agent-token") ?? "");
  function login(value: string) {
    sessionStorage.setItem("pi-agent-token", value);
    setToken(value);
  }
  function logout() {
    sessionStorage.removeItem("pi-agent-token");
    client.clear();
    setToken("");
  }
  if (document.querySelector('meta[name="pi-agent-host"][content="moviepilot"]')) {
    return <Workspace token="" />;
  }
  return token ? <Workspace token={token} onLogout={logout} /> : <Login onLogin={login} />;
}
