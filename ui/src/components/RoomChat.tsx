import React, { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { ChatMessage } from '../types';

interface RoomChatProps {
  messages: ChatMessage[];
  onSend: (text: string) => Promise<void>;
}

export const RoomChat: React.FC<RoomChatProps> = ({ messages, onSend }) => {
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages.length]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = draft.trim();
    if (!clean) return;
    setDraft('');
    await onSend(clean);
  };

  return (
    <div className="chat-wrap">
      <div ref={logRef} className="chat-log">
        {messages.length === 0 ? (
          <span className="field-hint">
            Nenhuma mensagem ainda. Mande um link ou combine o filme por aqui.
          </span>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`chat-msg ${m.self ? 'self' : ''}`}>
              <strong>{m.nickname}:</strong>
              <span>{m.text}</span>
            </div>
          ))
        )}
      </div>

      <form className="chat-form" onSubmit={(e) => void handleSubmit(e)}>
        <input
          className="input"
          placeholder="Escreva no chat da sala..."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={280}
        />
        <button
          type="submit"
          className="btn btn-secondary btn-icon"
          style={{ width: 34, height: 34, flexShrink: 0 }}
          aria-label="Enviar mensagem"
          title="Enviar mensagem"
        >
          <Send size={14} />
        </button>
      </form>
    </div>
  );
};
