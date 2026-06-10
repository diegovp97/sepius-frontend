import {
  Component,
  OnDestroy,
  AfterViewInit,
  signal,
  ElementRef,
  ViewChild,
  inject,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import Hls from 'hls.js';
import { environment } from '../../../environments/environment';

const API_BASE = environment.apiUrl;

@Component({
  selector: 'app-dashboard',
  standalone: true,
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
})
export class DashboardComponent implements AfterViewInit, OnDestroy {
  readonly channel = 'elttblue';
  private sanitizer = inject(DomSanitizer);
  readonly chatUrl: SafeResourceUrl = this.sanitizer.bypassSecurityTrustResourceUrl(
    `https://www.twitch.tv/embed/${this.channel}/chat?parent=${window.location.hostname}`
  );

  status = signal<'idle' | 'loading' | 'playing' | 'error'>('idle');
  errorMsg = signal('');
  reconnectCountdown = signal(0);
  isAtLiveEdge = signal(true);

  @ViewChild('videoEl') videoRef!: ElementRef<HTMLVideoElement>;

  private hls: Hls | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private readonly RECONNECT_DELAY_MS = 10_000;

  ngAfterViewInit(): void {
    this.startStream();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  async startStream(): Promise<void> {
    this.status.set('loading');
    this.errorMsg.set('');
    this.stopHls();

    try {
      const res = await fetch(`${API_BASE}/api/live/${this.channel}/start`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      this.pollUntilReady();
    } catch {
      this.status.set('error');
      this.errorMsg.set('No se pudo contactar con el backend. ¿Está corriendo dotnet run?');
    }
  }

  private pollUntilReady(): void {
    let attempts = 0;
    const MAX_ATTEMPTS = 30;

    this.pollTimer = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(`${API_BASE}/api/live/${this.channel}/status`);
        const data: { isReady: boolean; hlsUrl: string } = await res.json();

        if (data.isReady) {
          clearInterval(this.pollTimer!);
          this.pollTimer = null;
          this.mountHls(API_BASE + data.hlsUrl);
        } else if (attempts >= MAX_ATTEMPTS) {
          clearInterval(this.pollTimer!);
          this.status.set('error');
          this.errorMsg.set('El canal puede no estar en directo o streamlink no está instalado.');
        }
      } catch {
        clearInterval(this.pollTimer!);
        this.status.set('error');
        this.errorMsg.set('Error comprobando el estado del stream.');
      }
    }, 2000);
  }

  private mountHls(hlsUrl: string): void {
    const video = this.videoRef.nativeElement;

    if (Hls.isSupported()) {
      let mediaRecoveryAttempted = false;

      this.hls = new Hls({
        // Empezar siempre en el borde live (-1 = último segmento)
        startPosition: -1,
        maxBufferLength: 10,
        maxMaxBufferLength: 20,
        // Mantener latencia baja: ~3 segmentos de 2s = ~6s de retraso
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 4,
        levelLoadingTimeOut: 15000,
        fragLoadingTimeOut: 30000,
        fragLoadingMaxRetry: 4,
      });
      this.hls.loadSource(hlsUrl);
      this.hls.attachMedia(video);

      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // Saltar al borde live antes de reproducir
        if (Number.isFinite(video.duration)) {
          video.currentTime = video.duration;
        }
        video.play();
        this.status.set('playing');
        this.isAtLiveEdge.set(true);
      });

      // Detectar si el usuario se ha alejado del borde live
      video.addEventListener('timeupdate', () => {
        if (!this.hls) return;
        const latency = (this.hls as any).latency as number | undefined;
        this.isAtLiveEdge.set(latency === undefined || latency < 15);
      });

      this.hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            // Intentar recuperación de red antes de rendirse
            console.warn('[hls] Network error, attempting startLoad recovery:', data.details);
            this.hls?.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            if (!mediaRecoveryAttempted) {
              // Primera vez: intentar recuperación de media
              console.warn('[hls] Media error, attempting recoverMediaError:', data.details);
              mediaRecoveryAttempted = true;
              this.hls?.recoverMediaError();
            } else {
              // Segunda vez: el error es irrecuperable
              console.error('[hls] Media error unrecoverable:', data.details);
              this.status.set('error');
              this.errorMsg.set('Error de stream HLS. Reconectando...');
              this.scheduleReconnect();
            }
            break;
          default:
            console.error('[hls] Fatal error:', data.type, data.details);
            this.status.set('error');
            this.errorMsg.set('Error de stream HLS. Reconectando...');
            this.scheduleReconnect();
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl;
      video.addEventListener('loadedmetadata', () => {
        video.play();
        this.status.set('playing');
      });
    }
  }

  private scheduleReconnect(): void {
    this.reconnectCountdown.set(this.RECONNECT_DELAY_MS / 1000);
    this.countdownInterval = setInterval(() =>
      this.reconnectCountdown.update(v => v - 1), 1000);

    this.reconnectTimer = setTimeout(() => {
      clearInterval(this.countdownInterval!);
      this.startStream();
    }, this.RECONNECT_DELAY_MS);
  }

  jumpToLive(): void {
    const video = this.videoRef?.nativeElement;
    if (video && Number.isFinite(video.duration)) {
      video.currentTime = video.duration;
      video.play();
    }
    this.isAtLiveEdge.set(true);
  }

  reconnectNow(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.countdownInterval) clearInterval(this.countdownInterval);
    this.startStream();
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;
    const video = this.videoRef?.nativeElement;
    if (this.status() === 'error') {
      this.reconnectNow();
    } else if (video?.paused) {
      video.play().catch(() => {});
    }
  };

  private stopHls(): void {
    this.hls?.destroy();
    this.hls = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  ngOnDestroy(): void {
    this.stopHls();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.countdownInterval) clearInterval(this.countdownInterval);
    fetch(`${API_BASE}/api/live/${this.channel}/stop`, { method: 'POST' }).catch(() => {});
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }
}
