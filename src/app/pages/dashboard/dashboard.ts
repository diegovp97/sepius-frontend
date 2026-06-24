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
  platform = signal<'twitch' | 'kick' | null>(null);

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

  async startStream(): Promise<void> {
    console.log(`[sepius] startStream() → consultando /active para '${this.channel}'`);
    this.status.set('loading');
    this.errorMsg.set('');
    this.stopHls();

    try {
      const res = await fetch(`${API_BASE}/api/live/${this.channel}/active`);
      if (!res.ok) throw new Error(`API error ${res.status}`);

      const data: { isLive: boolean; platform: string | null; hlsUrl: string | null; isReady: boolean } = await res.json();
      console.log('[sepius] /active →', data);

      if (!data.isLive || !data.hlsUrl) {
        console.warn(`[sepius] Canal '${this.channel}' offline o sin HLS.`);
        this.status.set('error');
        this.errorMsg.set(`${this.channel} no está en directo ahora mismo.`);
        return;
      }

      this.platform.set(data.platform as 'twitch' | 'kick');

      if (data.isReady) {
        console.log(`[sepius] HLS listo en ${data.platform}. Montando: ${data.hlsUrl}`);
        this.mountHls(API_BASE + data.hlsUrl);
      } else {
        console.log(`[sepius] HLS aún no listo (platform=${data.platform}). Esperando...`);
        this.pollUntilReady(data.hlsUrl);
      }
    } catch (err) {
      console.error('[sepius] Error en startStream():', err);
      this.status.set('error');
      this.errorMsg.set('No se pudo contactar con el backend. ¿Está corriendo?');
    }
  }

  private pollUntilReady(hlsUrl: string): void {
    let attempts = 0;
    const MAX_ATTEMPTS = 15; // 15 × 2s = 30s máximo

    this.pollTimer = setInterval(async () => {
      attempts++;
      console.log(`[sepius] poll #${attempts} → /active`);
      try {
        const res = await fetch(`${API_BASE}/api/live/${this.channel}/active`);
        const data: { isLive: boolean; hlsUrl: string | null; isReady: boolean } = await res.json();
        console.log(`[sepius] poll #${attempts} ←`, data);

        if (data.isReady && data.hlsUrl) {
          clearInterval(this.pollTimer!);
          this.pollTimer = null;
          console.log(`[sepius] HLS listo tras ${attempts} intento(s). Montando.`);
          this.mountHls(API_BASE + data.hlsUrl);
        } else if (!data.isLive) {
          clearInterval(this.pollTimer!);
          this.pollTimer = null;
          console.warn('[sepius] Canal ya no en directo durante el poll.');
          this.status.set('error');
          this.errorMsg.set(`${this.channel} no está en directo ahora mismo.`);
        } else if (attempts >= MAX_ATTEMPTS) {
          clearInterval(this.pollTimer!);
          this.pollTimer = null;
          console.error('[sepius] Timeout esperando HLS listo.');
          this.status.set('error');
          this.errorMsg.set('El stream tardó demasiado en arrancar.');
        }
      } catch (err) {
        clearInterval(this.pollTimer!);
        this.pollTimer = null;
        console.error('[sepius] Error en poll:', err);
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
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 4,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 4,
        levelLoadingTimeOut: 15000,
        fragLoadingTimeOut: 30000,
        fragLoadingMaxRetry: 4,
        // Desactivar Web Worker: en algunos browsers el worker (blob URL) falla al
        // cargar, lo que provoca que el SourceBuffer sea eliminado del MediaSource
        // justo antes del primer appendBuffer → bufferAppendError fatal.
        // Sin worker, hls.js transmuxea TS→fMP4 en el hilo principal, más estable.
        enableWorker: false,
        // Cache-busting: forzar no-store en todas las peticiones de hls.js para
        // evitar que el browser sirva segmentos viejos de sesiones anteriores.
        xhrSetup: (xhr: XMLHttpRequest, url: string) => {
          xhr.setRequestHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        },
      });
      this.hls.loadSource(hlsUrl);
      this.hls.attachMedia(video);

      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[sepius] MANIFEST_PARSED → reproduciendo desde el live edge.');
        // Saltar al borde live antes de reproducir
        if (Number.isFinite(video.duration)) {
          video.currentTime = video.duration;
        }
        this.status.set('playing');
        this.isAtLiveEdge.set(true);
        video.play().catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'NotAllowedError') {
            console.warn('[sepius] Autoplay bloqueado. Esperando interacción del usuario.');
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
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }
}
