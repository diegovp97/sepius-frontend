import { Component, OnInit, OnDestroy, Input, signal, ViewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import * as signalR from '@microsoft/signalr';
import { environment } from '../../../../environments/environment';
import { EMOJIS, EmojiDef } from './emoji-list';
import { authFetch, getToken } from '../../../services/auth';

/** Trozo de un mensaje: texto normal o un emoji :nombre: ya resuelto a su imagen. */
interface Part {
  text?: string;
  emoji?: string;
  name?: string;
}

interface ReplyRef {
  id: number;
  nickname: string;
  text: string;
  parts?: Part[];
}

interface ChatMsg {
  id?: number;
  nickname: string;
  text: string;
  sentAt: string;
  color?: string;
  replyTo?: ReplyRef | null;
  parts?: Part[];
}

const EMOJI_URL = new Map(EMOJIS.map(e => [e.name, e.url]));
const SHORTCODE = /:([a-z0-9_-]{1,40}):/gi;

/** Separa el texto en trozos; los :nombre: que existen en el set de Owncast pasan a imagen. Nunca se usa innerHTML. */
function toParts(text: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(SHORTCODE)) {
    const url = EMOJI_URL.get(m[1].toLowerCase());
    if (!url) continue;
    if (m.index! > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ emoji: url, name: m[1].toLowerCase() });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

function withParts(m: ChatMsg): ChatMsg {
  return {
    ...m,
    parts: toParts(m.text),
    replyTo: m.replyTo ? { ...m.replyTo, parts: toParts(m.replyTo.text) } : m.replyTo,
  };
}

const COLORS = [
  '#ff6b6b','#ffa94d','#ffd43b','#a9e34b','#38d9a9',
  '#4dabf7','#748ffc','#da77f2','#f783ac','#63e6be'
];

function nickColor(nick: string): string {
  let h = 0;
  for (let i = 0; i < nick.length; i++) h = (h * 31 + nick.charCodeAt(i)) & 0xffffffff;
  return COLORS[Math.abs(h) % COLORS.length];
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './chat.html',
  styleUrl: './chat.css',
})
export class ChatComponent implements OnInit, OnDestroy {
  @Input() channel = '';
  @ViewChild('messagesEl') messagesEl!: ElementRef<HTMLDivElement>;
  @ViewChild('inputEl') inputEl?: ElementRef<HTMLInputElement>;

  messages = signal<ChatMsg[]>([]);
  nickname = signal(localStorage.getItem('chat-nickname') ?? '');
  text = '';
  connected = signal(false);
  nickSaved = signal(!!localStorage.getItem('chat-nickname'));
  editingNick = signal(false);
  replyingTo = signal<ChatMsg | null>(null);
  /** Hay sesión de admin (se inicia en /mod): muestra el botón de borrar. El permiso real lo valida el servidor con el JWT. */
  canModerate = signal(!!getToken());
  emojiOpen = signal(false);
  emojiFilter = signal('');
  readonly emojis = EMOJIS;
  filteredEmojis(): EmojiDef[] {
    const q = this.emojiFilter().trim().toLowerCase();
    return q ? EMOJIS.filter(e => e.name.includes(q)) : EMOJIS;
  }
  nickColor = (nick: string) => nickColor(nick);

  private hub!: signalR.HubConnection;

  async deleteMessage(m: ChatMsg): Promise<void> {
    if (!m.id || !confirm(`¿Borrar el mensaje de ${m.nickname}?\n\n"${m.text.slice(0, 120)}"`)) return;
    try {
      const res = await authFetch(`${environment.apiUrl}/api/chat/messages/${m.id}`, { method: 'DELETE' });
      if (res.ok || res.status === 404) this.removeMessage(m.id); // 404: ya no existía
      else alert('No se pudo borrar el mensaje.');
    } catch (e) {
      this.canModerate.set(false); // sesión caducada: authFetch ya borró el token
      alert(e instanceof Error ? e.message : 'No se pudo borrar el mensaje.');
    }
  }

  /** Quita el mensaje de la lista y sustituye su cita en las respuestas (el servidor hace lo mismo en la base de datos). */
  private removeMessage(id: number): void {
    const gone = '[mensaje eliminado]';
    this.messages.update(msgs => msgs
      .filter(x => x.id !== id)
      .map(x => x.replyTo?.id === id
        ? { ...x, replyTo: { ...x.replyTo, nickname: '—', text: gone, parts: [{ text: gone }] } }
        : x));
    if (this.replyingTo()?.id === id) this.replyingTo.set(null);
  }

  ngOnInit(): void {
    this.hub = new signalR.HubConnectionBuilder()
      .withUrl(`${environment.apiUrl}/hubs/chat`)
      .withAutomaticReconnect()
      .build();

    this.hub.on('ReceiveMessage', (nickname: string, text: string, sentAt: string, id?: number, replyTo?: ReplyRef | null) => {
      this.messages.update(msgs => [...msgs, withParts({ id, nickname, text, sentAt, replyTo, color: nickColor(nickname) })]);
      setTimeout(() => this.scrollToBottom(), 50);
    });

    this.hub.on('MessageDeleted', (id: number) => this.removeMessage(id));

    this.hub.on('History', (history: ChatMsg[]) => {
      this.messages.set(history.map(m => withParts({ ...m, color: nickColor(m.nickname) })));
      setTimeout(() => this.scrollToBottom(), 50);
    });

    this.hub.onreconnected(() => this.connected.set(true));
    this.hub.onclose(() => this.connected.set(false));

    this.hub.start().then(() => {
      this.connected.set(true);
      this.hub.invoke('GetHistory');
    });
  }

  saveNickname(): void {
    const n = this.nickname().trim();
    if (!n) return;
    localStorage.setItem('chat-nickname', n);
    this.nickSaved.set(true);
    this.editingNick.set(false);
  }

  async send(): Promise<void> {
    const t = this.text.trim();
    const n = this.nickname().trim();
    if (!t || !n || !this.connected()) return;
    const reply = this.replyingTo();
    this.text = '';
    this.replyingTo.set(null);
    if (reply?.id) await this.hub.invoke('SendReply', n, t, reply.id);
    else await this.hub.invoke('SendMessage', n, t);
  }

  /** ¿Es una respuesta a un mensaje mío? (mismo nick; no hay cuentas, así que es lo mejor que se puede saber) */
  isReplyToMe(msg: ChatMsg): boolean {
    const me = this.nickname().trim().toLowerCase();
    return !!me && !!msg.replyTo && msg.replyTo.nickname.trim().toLowerCase() === me
      && msg.nickname.trim().toLowerCase() !== me;
  }

  toggleEmoji(): void {
    this.emojiOpen.update(v => !v);
    if (this.emojiOpen()) this.emojiFilter.set('');
  }

  /** Inserta :nombre: en la posición del cursor y deja el foco en el campo de texto. */
  insertEmoji(e: EmojiDef): void {
    const input = this.inputEl?.nativeElement;
    const code = `:${e.name}:`;
    const start = input?.selectionStart ?? this.text.length;
    const end = input?.selectionEnd ?? this.text.length;
    const next = this.text.slice(0, start) + code + this.text.slice(end);
    if (next.length > 500) return;
    this.text = next;
    setTimeout(() => {
      if (!input) return;
      input.focus();
      const pos = start + code.length;
      input.setSelectionRange(pos, pos);
    }, 0);
  }

  startReply(msg: ChatMsg): void {
    if (!msg.id) return; // sin id (no se guardó en la base de datos) no se puede citar
    this.replyingTo.set(msg);
    setTimeout(() => this.inputEl?.nativeElement.focus(), 0);
  }

  cancelReply(): void {
    this.replyingTo.set(null);
  }

  /** Salta al mensaje original si sigue en pantalla y lo resalta un momento. */
  goToOriginal(id: number): void {
    const el = this.messagesEl?.nativeElement.querySelector<HTMLElement>(`[data-msg-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('chat__msg--flash');
    setTimeout(() => el.classList.remove('chat__msg--flash'), 1400);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    } else if (event.key === 'Escape') {
      if (this.emojiOpen()) this.emojiOpen.set(false);
      else if (this.replyingTo()) this.cancelReply();
    }
  }

  private scrollToBottom(): void {
    const el = this.messagesEl?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  ngOnDestroy(): void {
    this.hub?.stop();
  }
}
