import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TranscriptBlock } from "@mp-pi/contracts";

interface Props {
  text: string;
  transcript: TranscriptBlock[];
  collapsedThinking: Set<string>;
  onThinkingToggle(id: string, open: boolean): void;
}

const toolStates = { running: "执行中", completed: "已完成", failed: "失败" };

function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

export function AssistantContent({ text, transcript, collapsedThinking, onThinkingToggle }: Props) {
  if (transcript.length === 0) {
    return (
      <div className="assistant-text">
        <Markdown>{text}</Markdown>
      </div>
    );
  }
  return (
    <div className="assistant-transcript">
      {transcript.map((block) => {
        switch (block.type) {
          case "text":
            return (
              <div className="assistant-text" key={block.id}>
                <Markdown>{block.text}</Markdown>
              </div>
            );
          case "thinking":
            return (
              <details
                className="thinking-block"
                key={block.id}
                open={!collapsedThinking.has(block.id)}
                onToggle={(event) => onThinkingToggle(block.id, event.currentTarget.open)}
              >
                <summary>思考</summary>
                <div className="assistant-text">
                  <Markdown>{block.text}</Markdown>
                </div>
              </details>
            );
          case "tool":
            return (
              <details className={`tool-block tool-${block.state}`} key={block.id}>
                <summary>
                  <code>{block.name}</code>
                  <span className="tool-state">{toolStates[block.state]}</span>
                </summary>
                <div className="tool-detail">
                  <span>输入</span>
                  <pre>{block.input}</pre>
                  {block.output && (
                    <>
                      <span>结果</span>
                      <pre>{block.output}</pre>
                    </>
                  )}
                </div>
              </details>
            );
        }
      })}
    </div>
  );
}
