import { useEffect, useRef, type FormEvent } from "react";
import type { ChatMessage } from "../../shared/protocol";

export function Chat({
  messages,
  onSend,
  disabled,
}: {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  disabled: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scroller.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("chat") as HTMLInputElement;
    const text = input.value.trim();
    if (!text) {
      return;
    }
    onSend(text);
    input.value = "";
  }

  return (
    <section className="panel chat">
      <header>
        <h2>Chat</h2>
      </header>
      <div className="chat-log" ref={scroller}>
        {messages.length === 0 ? <p className="empty">Say hi before the movie starts.</p> : null}
        {messages.map((message) => (
          <p key={`${message.from}-${message.at}`}>
            <strong>{message.name}</strong>
            <span>{message.text}</span>
          </p>
        ))}
      </div>
      <form onSubmit={submit}>
        <input name="chat" maxLength={2000} placeholder="Message" disabled={disabled} autoComplete="off" />
        <button type="submit" disabled={disabled}>
          Send
        </button>
      </form>
    </section>
  );
}
