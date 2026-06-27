import { Component, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';

const API_BASE = environment.apiUrl;

interface Recording {
  fileName: string;
  fullPath: string;
  sizeMB: number;
  lastModified: string;
}

interface UploadResult {
  videoId: string;
  url: string;
}

@Component({
  selector: 'app-youtube',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './youtube.html',
  styleUrl: './youtube.css',
})
export class YoutubeComponent implements OnInit {
  recordings = signal<Recording[]>([]);
  loading = signal(true);
  error = signal('');
  uploading = signal<string | null>(null);
  uploadResults = signal<Map<string, UploadResult>>(new Map());
  uploadErrors = signal<Map<string, string>>(new Map());
  channel = signal('elttblue');
  selected = signal<Set<string>>(new Set());

  ngOnInit(): void {
    this.loadRecordings();
  }

  async loadRecordings(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const res = await fetch(`${API_BASE}/api/recordings/list?channelName=${this.channel()}`);
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const data: Recording[] = await res.json();
      this.recordings.set(data.sort((a, b) => b.lastModified.localeCompare(a.lastModified)));
    } catch (err) {
      console.error('Error loading recordings:', err);
      this.error.set('No se pudieron cargar las grabaciones.');
    } finally {
      this.loading.set(false);
    }
  }

  toggleSelect(fileName: string): void {
    this.selected.update(s => {
      const next = new Set(s);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  }

  isSelected(fileName: string): boolean {
    return this.selected().has(fileName);
  }

  selectAll(): void {
    const all = new Set(this.recordings().map(r => r.fileName));
    this.selected.set(all);
  }

  deselectAll(): void {
    this.selected.set(new Set());
  }

  async uploadSingle(recording: Recording): Promise<void> {
    this.uploading.set(recording.fileName);
    this.uploadErrors.update(m => { const n = new Map(m); n.delete(recording.fileName); return n; });

    try {
      const url = `${API_BASE}/api/recordings/upload?filePath=${encodeURIComponent(recording.fullPath)}&channelName=${this.channel()}`;
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `API error ${res.status}`);
      }
      const data: UploadResult = await res.json();
      this.uploadResults.update(m => { const n = new Map(m); n.set(recording.fileName, data); return n; });
    } catch (err: any) {
      console.error('Upload error:', err);
      this.uploadErrors.update(m => { const n = new Map(m); n.set(recording.fileName, err.message || 'Error desconocido'); return n; });
    } finally {
      this.uploading.set(null);
    }
  }

  async uploadSelected(): Promise<void> {
    const toUpload = this.recordings().filter(r => this.selected().has(r.fileName));
    for (const rec of toUpload) {
      if (this.uploadResults().has(rec.fileName)) continue;
      await this.uploadSingle(rec);
    }
  }

  formatDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  }

  formatSize(mb: number): string {
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb} MB`;
  }
}
