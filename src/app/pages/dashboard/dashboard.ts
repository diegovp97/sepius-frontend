import {
  Component,
  OnDestroy,
  AfterViewInit,
  signal,
  ElementRef,
  ViewChild,
} from '@angular/core';
import Hls from 'hls.js';
import { environment } from '../../../environments/environment';
import { ChatComponent } from './chat/chat';

const API_BASE = environment.apiUrl;

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [ChatComponent],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
})
export class DashboardComponent implements AfterViewInit, OnDestroy {
  readonly channel = 'elttblue';
  platform = signal<'twitch' | 'kick'>('kick');

  status = signal<'idle' | 'loading' | 'playing' | 'error'>('idle');
  errorMsg = signal('');
  reconnectCountdown = signal(0);
  isAtLiveEdge = signal(true);
  needsInteraction = signal(false);

  @ViewChild('videoEl') videoRef!: ElementRef<HTMLVideoElement>;

  private hls: Hls | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly RECONNECT_DELAY_MS = 10_000;
  private readonly STALL_TIMEOUT_MS = 4_000;

  ngAfterViewInit(): void {
    this.startStream();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  selectPlatform(p: 'twitch' | 'kick'): void {
    if (this.platform() === p) return;
    this.platform.set(p);
    this.startStream();
  }

  async startStream(): Promise<void> {
    this.status.set('loading');
    this.errorMsg.set('');
    this.stopHls();

    try {
      // Primero consultar si el stream ya está listo (ej: refresco de página)
      const statusRes = await fetch(`${API_BASE}/api/live/${this.channel}/status?platform=${this.platform()}`);
      if (statusRes.ok) {
        const statusData: { isReady: boolean; hlsUrl: string } = await statusRes.json();
        if (statusData.isReady) {
          this.mountHls(API_BASE + statusData.hlsUrl);
          return;
        }
      }

      // Si no está listo, arrancar el transcoding
      const res = await fetch(`${API_BASE}/api/live/${this.channel}/start?platform=${this.platform()}`, {
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
    const MAX_ATTEMPTS = 15;           // 15 × 2s = 30s máximo
    const MIN_ATTEMPTS_BEFORE_FAIL = 4; // dar 8s para que streamlink arranque

    this.pollTimer = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(`${API_BASE}/api/live/${this.channel}/status?platform=${this.platform()}`);
        const data: { isReady: boolean; isTranscoding: boolean; hlsUrl: string } = await res.json();

        if (data.isReady) {
          clearInterval(this.pollTimer!);
          this.pollTimer = null;
          this.mountHls(API_BASE + data.hlsUrl);
        } else if (attempts >= MIN_ATTEMPTS_BEFORE_FAIL && !data.isTranscoding) {
          // streamlink murió sin producir segmentos → canal offline o error
          clearInterval(this.pollTimer!);
          this.pollTimer = null;
          this.status.set('error');
          this.errorMsg.set(`${this.channel} no está en directo ahora mismo.`);
        } else if (attempts >= MAX_ATTEMPTS) {
          clearInterval(this.pollTimer!);
          this.pollTimer = null;
          this.status.set('error');
          this.errorMsg.set('El canal puede no estar en directo o streamlink no está instalado.');
        }
      } catch {
        clearInterval(this.pollTimer!);
        this.pollTimer = null;
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
        maxBufferLength: 4,
        maxMaxBufferLength: 8,
        backBufferLength: 0,
        // 2 segmentos de 1s = ~2s de latencia añadida
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 4,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 4,
        levelLoadingTimeOut: 15000,
        fragLoadingTimeOut: 30000,
        fragLoadingMaxRetry: 4,
        // Cache-busting: el navegador puede servir m3u8/segmentos viejos de la disk
        // cache (de sesiones anteriores con distinto codec/resolución), provocando
        // bufferAppendError. Forzamos no-store en TODAS las peticiones de hls.js.
        xhrSetup: (xhr: XMLHttpRequest, url: string) => {
          xhr.setRequestHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        },
      });
      this.hls.loadSource(hlsUrl);
      this.hls.attachMedia(video);

      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // Saltar al borde live antes de reproducir
        if (Number.isFinite(video.duration)) {
          video.currentTime = video.duration;
        }
        this.status.set('playing');
        this.isAtLiveEdge.set(true);
        video.play().catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'NotAllowedError') {
            this.needsInteraction.set(true);
          }
        });
      });

      // Detectar stall: si el vídeo lleva STALL_TIMEOUT_MS sin avanzar, saltar al live edge
      const resetStallTimer = () => {
        if (this.stallTimer) clearTimeout(this.stallTimer);
        this.stallTimer = setTimeout(() => {
          if (!video.paused && this.hls) {
            console.warn('[hls] Stall detectado, saltando al live edge');
            if (Number.isFinite(video.duration)) {
              video.currentTime = video.duration - 0.5;
            }
            this.hls.startLoad(-1);
          }
        }, this.STALL_TIMEOUT_MS);
      };

      video.addEventListener('waiting', resetStallTimer);
      video.addEventListener('stalled', resetStallTimer);
      video.addEventListener('playing', () => {
        if (this.stallTimer) clearTimeout(this.stallTimer);
      });

      // Detectar si el usuario se ha alejado del borde live
      video.addEventListener('timeupdate', () => {
        if (!this.hls) return;
        const latency = (this.hls as any).latency as number | undefined;
        this.isAtLiveEdge.set(latency === undefined || latency < 15);
      });

      this.hls.on(Hls.Events.ERROR, (_, data) => {
        // Log completo para diagnóstico
        console.warn('[hls] ERROR event:', {
          fatal: data.fatal, type: data.type, details: data.details,
          reason: (data as any).reason, err: (data as any).err?.message,
          mimeType: (data as any).mimeType,
        });
        // Errores no fatales de fragmento: saltar al live edge en lugar de reintentar el frag roto
        if (!data.fatal && data.details?.startsWith('frag')) {
          console.warn('[hls] Frag error (non-fatal), saltando al live edge:', data.details);
          if (Number.isFinite(video.duration)) {
            video.currentTime = video.duration - 0.5;
          }
          this.hls?.startLoad(-1);
          return;
        }

        if (!data.fatal) return;

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            console.warn('[hls] Network error fatal, saltando al live edge:', data.details);
            if (Number.isFinite(video.duration)) {
              video.currentTime = video.duration - 0.5;
            }
            this.hls?.startLoad(-1);
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

  clickToPlay(): void {
    const video = this.videoRef?.nativeElement;
    if (!video) return;
    this.needsInteraction.set(false);
    if (Number.isFinite(video.duration)) {
      video.currentTime = video.duration - 0.5;
    }
    video.play().catch(() => {});
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
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
    // Resetear el elemento <video> para eliminar cualquier MediaSource residual
    const video = this.videoRef?.nativeElement;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }

  ngOnDestroy(): void {
    this.stopHls();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.countdownInterval) clearInterval(this.countdownInterval);
    fetch(`${API_BASE}/api/live/${this.channel}/stop`, { method: 'POST' }).catch(() => {});
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }
}
