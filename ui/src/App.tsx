import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

type ChatReady = {
  jid: string;
  userId: string;
  displayName: string;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  sender?: string;
  timestamp?: string;
};

type WireEnvelope =
  | { type: "chat.ready"; payload: ChatReady }
  | { type: "chat.history"; payload: { jid: string; name: string; messages: ChatMessage[] } }
  | { type: "chat.message"; payload: ChatMessage }
  | { type: "chat.typing"; payload: { isTyping: boolean } }
  | { type: "chat.ack"; payload: { requestId: string | null } }
  | { type: "chat.error"; payload: { message: string } }
  | { type: "chat.subscribed"; payload: { jid: string } };

function toWebSocketUrl(): string {
  const target = new URL(import.meta.env.VITE_NANOCLAW_WEB_URL || window.location.origin);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  target.pathname = "/ws";
  return target.toString();
}

function createSocket(): WebSocket {
  return new WebSocket(toWebSocketUrl());
}

function MessageBody({ text }: { text: string }) {
  return (
    <div className="message-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function App() {
  const [ready, setReady] = useState<ChatReady | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("Connecting");
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem("nanoclaw-web-rail-collapsed");
    setRailCollapsed(stored === "1");
  }, []);

  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setStatus("Connected");
      socket.send(JSON.stringify({ type: "chat.subscribe" }));
      socket.send(JSON.stringify({ type: "chat.history" }));
    });

    socket.addEventListener("close", () => {
      setStatus("Disconnected");
      setIsTyping(false);
    });

    socket.addEventListener("error", () => {
      setStatus("Transport Error");
    });

    socket.addEventListener("message", (event) => {
      const envelope = JSON.parse(event.data as string) as WireEnvelope;
      switch (envelope.type) {
        case "chat.ready":
          setReady(envelope.payload);
          break;
        case "chat.history":
          setMessages(envelope.payload.messages);
          break;
        case "chat.message":
          setMessages((current) => [...current, envelope.payload]);
          break;
        case "chat.typing":
          setIsTyping(envelope.payload.isTyping);
          break;
        case "chat.error":
          setError(envelope.payload.message);
          setTimeout(() => setError(null), 4000);
          break;
        default:
          break;
      }
    });

    return () => {
      socket.close();
    };
  }, []);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isTyping]);

  const canSend = useMemo(() => status === "Connected" && input.trim().length > 0, [input, status]);
  const identityLabel = ready?.displayName ?? "Pending proxy";
  const sessionLabel = ready?.jid ?? "Not ready";

  const toggleRail = () => {
    setRailCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("nanoclaw-web-rail-collapsed", next ? "1" : "0");
      return next;
    });
  };

  const sendMessage = () => {
    if (!canSend || !socketRef.current) {
      return;
    }
    const text = input.trim();
    socketRef.current.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        type: "chat.send",
        payload: { text }
      })
    );
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text, sender: ready?.displayName }]);
    setInput("");
  };

  return (
    <div className={`shell${railCollapsed ? " shell-collapsed" : ""}`}>
      <div className="background-grid" />
      <aside className="rail">
        <div className="rail-top">
          <div>
            <p className="eyebrow">NanoClaw Codex Web</p>
            <h1>Trusted web chat, not a full console.</h1>
            <p className="lede">Single-operator browser channel on top of the existing NanoClaw queue and Codex runtime.</p>
          </div>
          <button
            type="button"
            className="rail-toggle"
            onClick={toggleRail}
            aria-expanded={!railCollapsed}
            aria-label={railCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {railCollapsed ? "Show" : "Hide"}
          </button>
        </div>
        <dl className="facts">
          <div>
            <dt>Status</dt>
            <dd>{status}</dd>
          </div>
          <div>
            <dt>Identity</dt>
            <dd>{identityLabel}</dd>
          </div>
          <div>
            <dt>Session</dt>
            <dd>{sessionLabel}</dd>
          </div>
        </dl>
        <p className="note">Chat-only surface. Global control, auth, mounts, and scheduling stay outside the browser UI.</p>
      </aside>

      <main className="panel">
        <header className="panel-header">
          <div>
            <p className="section-label">Web Channel</p>
            <h2>Conversation</h2>
          </div>
          {error ? <div className="error-badge">{error}</div> : null}
        </header>

        <div className="messages" ref={messagesRef}>
          {messages.map((message) => (
            <article key={message.id} className={`message message-${message.role}`}>
              <div className="message-meta">
                <span>{message.role === "assistant" ? "Codex" : message.sender || "You"}</span>
                {message.timestamp ? <span>{new Date(message.timestamp).toLocaleTimeString()}</span> : null}
              </div>
              <MessageBody text={message.text} />
            </article>
          ))}
          {isTyping ? (
            <article className="message message-assistant typing">
              <div className="message-meta">
                <span>Codex</span>
                <span>typing</span>
              </div>
              <div className="typing-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            </article>
          ) : null}
        </div>

        <footer className="composer">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Send a message into the NanoClaw queue…"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
          />
          <button type="button" onClick={sendMessage} disabled={!canSend}>
            Send
          </button>
        </footer>
      </main>
    </div>
  );
}
