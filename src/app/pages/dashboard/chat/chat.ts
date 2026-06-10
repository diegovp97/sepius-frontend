import {
  Component,
  OnInit,
  OnDestroy,
  Input,
  signal,
  ViewChild,
  ElementRef,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import * as signalR from '@microsoft/signalr';
import { environment } from '../../../../environments/environment';

interface ChatMsg {
  nickname: string;
  text: string;
  sentAt: string;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [FormsModule, DatePipe],
  templateUrl: './chat.html',
  styleUrl: './chat.css',
})
export class ChatComponent implements OnInit, OnDestroy {
  @Input() channel = '';
  @ViewChild('messagesEl') messagesEl!: ElementRef<HTMLDivElement>;

  messages = signal<ChatMsg[]>([]);
  nickname = signal(localStorage.getItem('chat-nickname') ?? '');
  text = '';
  connected = signal(false);
  nickSaved = signal(!!localStorage.getItem('chat-nickname'));

  private hub!: signalR.HubConnection;

  ngOnInit(): void {
    this.hub = new signalR.HubConnectionBuilder()
      .withUrl(`${environment.apiUrl}/hubs/chat`)
      .withAutomaticReconnect()
      .build();

    this.hub.on('ReceiveMessage', (nickname: string, text: string, sentAt: string) => {
      this.messages.update(msgs => [...msgs, { nickname, text, sentAt }]);
      setTimeout(() => this.scrollToBottom(), 50);
    });

    this.hub.on('History', (history: ChatMsg[]) => {
      this.messages.set(history);
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
  }

  async send(): Promise<void> {
    const t = this.text.trim();
    const n = this.nickname().trim();
    if (!t || !n || !this.connected()) return;
    this.text = '';
    await this.hub.invoke('SendMessage', n, t);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
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
