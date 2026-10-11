import { Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Clip, ClipError, ClipsService } from '../../../services/clips.service';

/** Ventana para crear un clip de los últimos segundos del directo. */
@Component({
  selector: 'app-clip-create',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './clip-create.html',
  styleUrl: './clip-create.css',
})
export class ClipCreateComponent {
  @Input() channel = '';
  /** Segundos que el espectador va por detrás del borde live: el clip termina donde él está viendo. */
  @Input() behindSeconds: () => number = () => 0;
  @Output() closed = new EventEmitter<void>();

  readonly options = [15, 30, 45, 60];
  seconds = signal(30);
  title = '';
  creating = signal(false);
  error = signal('');
  clip = signal<Clip | null>(null);
  copied = signal(false);

  constructor(readonly clips: ClipsService) {}

  async create(): Promise<void> {
    if (this.creating()) return;
    this.creating.set(true);
    this.error.set('');
    try {
      const clip = await this.clips.create({
        channel: this.channel,
        seconds: this.seconds(),
        behindSeconds: Math.max(0, Math.min(20, Math.round(this.behindSeconds()))),
        title: this.title.trim(),
        nickname: localStorage.getItem('chat-nickname') ?? '',
      });
      this.clip.set(clip);
    } catch (e) {
      this.error.set(e instanceof ClipError ? e.message : 'No se pudo crear el clip.');
    } finally {
      this.creating.set(false);
    }
  }

  link(): string {
    const c = this.clip();
    return c ? `${location.origin}/clips/${c.id}` : '';
  }

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.link());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1800);
    } catch {
      // Sin permiso para el portapapeles: el enlace sigue visible para copiarlo a mano.
    }
  }

  close(): void {
    this.closed.emit();
  }
}
