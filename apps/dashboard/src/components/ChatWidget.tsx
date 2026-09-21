import { useEffect, useRef, useState } from 'react';
import { ArrowUp, BookOpen, MessageCircle, RotateCcw, X } from 'lucide-react';
import './chat.css';
import type { ApiClient } from '../lib/api';

type Source = { id: string; caseId: string; title: string; excerpt: string };
type Message = { role: 'user' | 'assistant'; content: string; sources?: Source[]; mode?: string; fallbackReason?: string };
const fallbackNotes: Record<string, string> = {
  not_configured: 'The summary model is not configured. Showing checked email excerpts.',
  provider_unavailable: 'The summary provider could not respond. Showing checked excerpts; please retry.',
  generation_timeout: 'The summary timed out. Showing checked excerpts; please retry.',
  invalid_response: 'The summary had an invalid format. Showing checked excerpts; please retry.',
  verification_unavailable: 'The answer verification service could not respond. Showing checked excerpts; please retry.',
  unsupported_answer: 'The summary did not pass the evidence check. Showing checked excerpts.',
};
const prompts = ['Find emails about urgent shipments', 'Which emails mention missing documents?', 'Give me an inbox overview'];
const welcome: Message = { role: 'assistant', content: 'Ask me about your workspace emails. Find a booking, summarize an email, or investigate missing documents. Open cited records to check each answer.' };

function isReply(value: unknown): value is { answer: string; sources: Source[]; mode: string; fallbackReason?: string } {
  if (!value || typeof value !== 'object' || !('answer' in value) || typeof value.answer !== 'string' || !('mode' in value) || typeof value.mode !== 'string' || !('sources' in value) || !Array.isArray(value.sources)) return false;
  return value.sources.every((source: unknown) => !!source && typeof source === 'object' && 'id' in source && typeof source.id === 'string' && 'title' in source && typeof source.title === 'string' && 'caseId' in source && typeof source.caseId === 'string' && 'excerpt' in source && typeof source.excerpt === 'string');
}

export function ChatWidget({ api, selectedId, onOpenCase, tourOpen = false }: { api: ApiClient; selectedId: string | null; onOpenCase: (id: string) => void; tourOpen?: boolean }) {
  const [scope, setScope] = useState('all');
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([welcome]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { setOpen(tourOpen); }, [tourOpen]);

  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [messages, pending, error, open]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (scope !== 'selected') return;
    controller.current?.abort(); controller.current = null;
    setMessages([welcome]); setError(''); setPending(false);
  }, [selectedId, scope]);

  function close() { setOpen(false); launcher.current?.focus(); }

  async function send(text: string) {
    const message = text.trim();
    if (!message || message.length > 1000 || controller.current) return;
    const next = [...messages, { role: 'user' as const, content: message }];
    const request = new AbortController(); controller.current = request;
    setMessages(next); setDraft(''); setError(''); setPending(true);
    const timeout = window.setTimeout(() => request.abort(), 65000);
    try {
      const reply = await api.chat({ message, history: messages.slice(1).slice(-8).map(item => ({ role: item.role, content: item.content.slice(0, 4000) })), ...(scope === 'selected' && selectedId ? { caseId: selectedId } : {}) }, request.signal);
      if (controller.current !== request) return;
      if (!isReply(reply)) throw new Error('The assistant returned an incomplete reply. Please try again.');
      setMessages([...next, { role: 'assistant', content: reply.answer, sources: reply.sources, mode: reply.mode, fallbackReason: typeof reply.fallbackReason === 'string' ? reply.fallbackReason : undefined }]);
    } catch (failure) {
      if (controller.current !== request) return;
      setMessages(messages); setDraft(message);
      setError(request.signal.aborted ? 'The reply took too long. Please try again.' : failure instanceof Error ? failure.message : 'Couldn’t connect. Please try again.');
    } finally {
      window.clearTimeout(timeout);
      if (controller.current === request) { controller.current = null; setPending(false); if (open) input.current?.focus(); }
    }
  }

  return <div className="chat-widget">
    {open && <section id="cargolens-chat" role="dialog" aria-labelledby="chat-title" className="chat-panel" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <header className="chat-header">
        <span className="chat-avatar"><MessageCircle size={21} aria-hidden="true" /></span>
        <div><h2 id="chat-title">Ask your inbox</h2><p>Answers grounded in your email evidence</p></div>
        <button type="button" className="chat-icon" aria-label="Start new conversation" disabled={pending} onClick={() => { setMessages([welcome]); setError(''); setDraft(''); input.current?.focus(); }}><RotateCcw size={17} /></button>
        <button type="button" className="chat-icon" aria-label="Close chat" onClick={close}><X size={21} /></button>
      </header>
      <div className="chat-scope" data-tour="chat-scope"><label htmlFor="chat-scope">Search</label><select id="chat-scope" value={scope} disabled={pending} onChange={event => { setScope(event.target.value); setMessages([welcome]); setError(''); }}><option value="all">All workspace emails</option><option value="selected" disabled={!selectedId}>Selected email{selectedId ? ` - ${selectedId}` : ''}</option></select></div>
      <div ref={log} className="chat-log" role="log" aria-live="polite" aria-relevant="additions text" aria-busy={pending}>
        {messages.map((message, index) => <div key={index} className={`chat-message chat-message--${message.role}`}>
          <span className="chat-speaker">{message.role === 'user' ? 'You' : 'CargoLens'}</span>
          <p>{message.content}</p>
          {!!message.sources?.length && <div className="chat-sources" aria-label="Answer sources"><span><BookOpen size={12} aria-hidden="true" /> Sources</span>{message.sources.map((source, number) => <button type="button" key={source.id} title={source.excerpt} onClick={() => { onOpenCase(source.caseId); close(); }}>[{number + 1}] {source.caseId} - {source.title}</button>)}</div>}
          {message.mode && <small className="chat-note">{message.mode === 'generated' ? 'Jev checked: relevance, grounding and citations' : fallbackNotes[message.fallbackReason ?? ''] ?? (message.mode === 'retrieval' || message.mode === 'answer_rejected' ? 'Showing Jev-screened email excerpts.' : 'No unchecked answer shown.')}</small>}
        </div>)}
        {messages.length === 1 && <div className="chat-prompts" aria-label="Suggested questions">{prompts.map(prompt => <button key={prompt} type="button" onClick={() => void send(prompt)}>{prompt} <span aria-hidden="true">↗</span></button>)}</div>}
        {pending && <p className="chat-pending" role="status">Retrieving emails and checking evidence with Jev...</p>}
      </div>
      <form data-tour="chat-compose" className="chat-compose" onSubmit={event => { event.preventDefault(); void send(draft); }}>
        {error && <p className="chat-error" role="alert">{error} Your question is ready to resend.</p>}
        <div className="chat-input-row"><label className="chat-sr-only" htmlFor="chat-question">Ask CargoLens a question</label><input ref={input} id="chat-question" value={draft} onChange={event => setDraft(event.target.value)} maxLength={1000} placeholder="Ask about your emails..." autoComplete="off" /><button type="submit" aria-label="Send message" disabled={pending || !draft.trim()}><ArrowUp size={20} /></button></div>
        <p>Read-only assistant. Check cited email evidence.</p>
      </form>
    </section>}
    <button data-tour="chat-launcher" ref={launcher} type="button" className="chat-launcher" aria-label={open ? 'Close CargoLens chat' : 'Open CargoLens chat'} aria-expanded={open} aria-controls="cargolens-chat" onClick={() => open ? close() : setOpen(true)}>
      {open ? <X size={23} aria-hidden="true" /> : <><MessageCircle size={23} aria-hidden="true" /><span>Ask CargoLens</span></>}
    </button>
  </div>;
}
