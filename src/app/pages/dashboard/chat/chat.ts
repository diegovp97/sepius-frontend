import { Component, OnInit, OnDestroy, Input, signal, ViewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import * as signalR from '@microsoft/signalr';
import { environment } from '../../../../environments/environment';

interface ReplyRef {
  id: number;
  nickname: string;
  text: string;
}

interface ChatMsg {
  id?: number;
  nickname: string;
  text: string;
  sentAt: string;
  color?: string;
  replyTo?: ReplyRef | null;
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
  nickColor = (nick: string) => nickColor(nick);

  private hub!: signalR.HubConnection;

  ngOnInit(): void {
    this.hub = new signalR.HubConnectionBuilder()
      .withUrl(`${environment.apiUrl}/hubs/chat`)
      .withAutomaticReconnect()
      .build();

    this.hub.on('ReceiveMessage', (nickname: string, text: string, sentAt: string, id?: number, replyTo?: ReplyRef | null) => {
      this.messages.update(msgs => [...msgs, { id, nickname, text, sentAt, replyTo, color: nickColor(nickname) }]);
      setTimeout(() => this.scrollToBottom(), 50);
    });

    this.hub.on('History', (history: ChatMsg[]) => {
      this.messages.set(history.map(m => ({ ...m, color: nickColor(m.nickname) })));
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
    } else if (event.key === 'Escape' && this.replyingTo()) {
      this.cancelReply();
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
