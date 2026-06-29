import { Component, OnInit, OnDestroy, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';

const API_BASE = environment.apiUrl;

interface Recording {
  fileName: string;
  fullPath: string;
  sizeMB: number;
  lastModified: string;
}

interface UploadJob {
  jobId: string;
  status: 'Queued' | 'Uploading' | 'Completed' | 'Failed';
  videoId?: string;
  url?: string;
  error?: string;
  fileName?: string;
}

@Component({
  selector: 'app-youtube',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './youtube.html',
  styleUrl: './youtube.css',
})
export class YoutubeComponent implements OnInit, OnDestroy {
  recordings = signal<Recording[]>([]);
  loading = signal(true);
  error = signal('');
  uploading = signal<string | null>(null);
  uploadJobs = signal<Map<string, UploadJob>>(new Map());
  uploadErrors = signal<Map<string, string>>(new Map());
  channel = signal('elttblue');
  selected = signal<Set<string>>(new Set());
  previewRec = signal<Recording | null>(null);
  expandedRow = signal<string | null>(null);

  private pollIntervals = new Map<string, ReturnType<typeof setInterval>>();

  ngOnInit(): void {
    this.loadRecordings();
  }

  ngOnDestroy(): void {
    this.pollIntervals.forEach(clearInterval);
    this.pollIntervals.clear();
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

      if (res.status === 202) {
        const data: UploadJob = await res.json();
        data.fileName = recording.fileName;
        this.uploadJobs.update(m => { const n = new Map(m); n.set(recording.fileName, data); return n; });
        this.pollJobStatus(recording.fileName, data.jobId);
      } else if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `API error ${res.status}`);
      } else {
        const data = await res.json();
        const job: UploadJob = { jobId: '', status: 'Completed', videoId: data.videoId, url: data.url, fileName: recording.fileName };
        this.uploadJobs.update(m => { const n = new Map(m); n.set(recording.fileName, job); return n; });
      }
    } catch (err: any) {
      console.error('Upload error:', err);
      this.uploadErrors.update(m => { const n = new Map(m); n.set(recording.fileName, err.message || 'Error desconocido'); return n; });
    } finally {
      this.uploading.set(null);
    }
  }

  private pollJobStatus(fileName: string, jobId: string): void {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/recordings/upload/status/${jobId}`);
        if (!res.ok) return;
        const job: UploadJob = await res.json();
        job.fileName = fileName;

        this.uploadJobs.update(m => { const n = new Map(m); n.set(fileName, job); return n; });

        if (job.status === 'Completed' || job.status === 'Failed') {
          clearInterval(interval);
          this.pollIntervals.delete(fileName);

          if (job.status === 'Completed' && job.videoId) {
            this.uploadJobs.update(m => {
              const n = new Map(m);
              const existing = n.get(fileName);
              if (existing) {
                existing.url = `https://youtu.be/${job.videoId}`;
                n.set(fileName, { ...existing });
              }
              return n;
            });
          }

          if (job.status === 'Failed' && job.error) {
            this.uploadErrors.update(m => { const n = new Map(m); n.set(fileName, job.error!); return n; });
          }
        }
      } catch {
        // retry on next tick
      }
    }, 3000);

    this.pollIntervals.set(fileName, interval);
  }

  async uploadSelected(): Promise<void> {
    const toUpload = this.recordings().filter(r => this.selected().has(r.fileName));
    for (const rec of toUpload) {
      if (this.uploadJobs().has(rec.fileName)) continue;
      await this.uploadSingle(rec);
    }
  }

  getJobStatus(fileName: string): string {
    return this.uploadJobs().get(fileName)?.status || '';
  }

  getJobVideoId(fileName: string): string | undefined {
    return this.uploadJobs().get(fileName)?.videoId;
  }

  getJobUrl(fileName: string): string | undefined {
    return this.uploadJobs().get(fileName)?.url;
  }

  getStreamUrl(recording: Recording): string {
    return `${API_BASE}/api/recordings/stream?filePath=${encodeURIComponent(recording.fullPath)}`;
  }

  getDownloadUrl(recording: Recording): string {
    return `${API_BASE}/api/recordings/stream?filePath=${encodeURIComponent(recording.fullPath)}&download=true`;
  }

  openPreview(recording: Recording): void {
    this.previewRec.set(recording);
  }

  closePreview(): void {
    this.previewRec.set(null);
  }

  toggleInlinePreview(fileName: string): void {
    this.expandedRow.update(current => current === fileName ? null : fileName);
  }

  isExpanded(fileName: string): boolean {
    return this.expandedRow() === fileName;
  }

  downloadRecording(recording: Recording): void {
    window.open(this.getDownloadUrl(recording), '_blank');
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
