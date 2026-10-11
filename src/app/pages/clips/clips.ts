import { Component, OnInit, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Clip, ClipsService } from '../../services/clips.service';

/** /clips = galería de clips; /clips/:id = un clip (enlace para compartir) con la galería debajo. */
@Component({
  selector: 'app-clips',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './clips.html',
  styleUrl: './clips.css',
})
export class ClipsComponent implements OnInit {
  clips = signal<Clip[]>([]);
  current = signal<Clip | null>(null);
  loading = signal(true);
  notFound = signal(false);
  failed = signal(false);

  constructor(readonly api: ClipsService, private readonly route: ActivatedRoute) {}

  ngOnInit(): void {
    // El id cambia al pulsar otro clip sin recrear el componente.
    this.route.paramMap.subscribe(p => this.loadCurrent(p.get('id')));
    this.loadList();
  }

  private async loadList(): Promise<void> {
    try {
      this.clips.set(await this.api.list(48));
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadCurrent(id: string | null): Promise<void> {
    this.notFound.set(false);
    if (!id) {
      this.current.set(null);
      return;
    }
    try {
      const clip = await this.api.get(id);
      this.current.set(clip);
      this.notFound.set(!clip);
      if (clip) window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      this.current.set(null);
      this.failed.set(true);
    }
  }

  duration(s: number): string {
    const t = Math.round(s);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }

  ago(iso: string): string {
    const diff = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60) return 'hace un momento';
    if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
    if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
    return `hace ${Math.floor(diff / 86400)} d`;
  }

  async copy(clip: Clip): Promise<void> {
    try {
      await navigator.clipboard.writeText(`${location.origin}/clips/${clip.id}`);
    } catch { /* sin permiso: no pasa nada */ }
  }
}
