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
import { RouterLink } from '@angular/router';
import { ChatComponent } from './chat/chat';
import { ClipCreateComponent } from './clip-create/clip-create';
import { ChromecastService } from '../../services/chromecast.service';

const API_BASE = environment.apiUrl;

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [ChatComponent, ClipCreateComponent, RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
})
export class DashboardComponent implements AfterViewInit, OnDestroy {
  // Por defecto elttblue; ?canal=<nombre> permite abrir otro canal retransmitido (pruebas).
  readonly channel = DashboardComponent.resolveChannel();
  platform = signal<'twitch' | 'kick' | 'starvios' | null>(null);

  private static resolveChannel(): string {
    const c = new URLSearchParams(window.location.search).get('canal')?.trim().toLowerCase();
    return c && /^[a-z0-9_]{1,25}$/.test(c) ? c : 'elttblue';
  }
  private currentHlsUrl = '';
  /** URL del HLS original (720p60); la ligera cuelga de ella en /low/. */
  private sourceUrl = '';

  // ── Calidad ──────────────────────────────────────────────────────────────
  // Auto = ligera en móvil o con conexión lenta; Original = lo que emite el streamer (~7 Mbps en Twitch/Kick).
  quality = signal<'auto' | 'source' | 'low'>(DashboardComponent.savedQuality());
  effectiveQuality = signal<'source' | 'low'>('source');
  lowAvailable = signal(false);
  qualityMenuOpen = signal(false);
  qualityNotice = signal('');
  private autoDowngraded = false;
  private stallTimes: number[] = [];

  private static savedQuality(): 'auto' | 'source' | 'low' {
    try {
      const v = localStorage.getItem('sepius-quality');
      return v === 'source' || v === 'low' ? v : 'auto';
    } catch {
      return 'auto';
    }
  }

  status = signal<'idle' | 'loading' | 'playing' | 'error'>('idle');
  errorMsg = signal('');
  reconnectCountdown = signal(0);
  isAtLiveEdge = signal(true);
  needsInteraction = signal(false);
  clipOpen = signal(false);

  @ViewChild('videoEl') videoRef!: ElementRef<HTMLVideoElement>;

  private hls: Hls | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private liveCheckTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private reconnectPending = false;
  private startRun = 0;
  private videoListeners: Array<[string, EventListener]> = [];
  private readonly log: (...args: unknown[]) => void =
    environment.production ? () => {} : console.log.bind(console);
  private readonly RECONNECT_DELAY_MS = 10_000;
  private readonly RECONNECT_MAX_MS = 60_000;
  private readonly STALL_TIMEOUT_MS = 10_000;
  private readonly LIVE_CHECK_INTERVAL_MS = 15_000;

  constructor(public readonly cast: ChromecastService) {}

  ngAfterViewInit(): void {
    this.startStream();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  async startStream(): Promise<void> {
    const run = ++this.startRun;
    this.clearReconnect();
    this.log(`[sepius] startStream() → consultando /active para '${this.channel}'`);
    this.status.set('loading');
    this.errorMsg.set('');
    this.stopHls();

    try {
      const res = await fetch(`${API_BASE}/api/live/${this.channel}/active`);
      if (!res.ok) throw new Error(`API error ${res.status}`);

      const data: { isLive: boolean; platform: string | null; hlsUrl: string | null; isReady: boolean } = await res.json();
      if (run !== this.startRun) return; // llegó otra llamada más reciente
      this.log('[sepius] /active →', data);

      if (!data.isLive || !data.hlsUrl) {
        console.warn(`[sepius] Canal '${this.channel}' offline o sin HLS.`);
        this.status.set('error');
        this.errorMsg.set(`${this.channel} no está en directo ahora mismo.`);
        return; // apagado: sin sondeo en bucle; se vuelve a comprobar a mano o al volver a la pestaña
      }

      this.platform.set(data.platform as 'twitch' | 'kick' | 'starvios');

      if (data.isReady) {
        const rawUrl = data.hlsUrl.startsWith('/') ? `${API_BASE}${data.hlsUrl}` : data.hlsUrl;
        const fullUrl = rawUrl;
        this.currentHlsUrl = fullUrl;
        this.log(`[sepius] HLS listo en ${data.platform}. Montando: ${fullUrl}`);
        void this.mountChosen(fullUrl);
      } else {
        this.log(`[sepius] HLS aún no listo (platform=${data.platform}). Esperando...`);
        this.pollUntilReady(data.hlsUrl);
      }
    } catch (err) {
      if (run !== this.startRun) return;
      console.error('[sepius] Error en startStream():', err);
      this.status.set('error');
      this.errorMsg.set('No se pudo contactar con el servidor. Reintentando…');
      this.scheduleReconnect();
    }
  }

  private pollUntilReady(hlsUrl: string): void {
    let attempts = 0;
    const MAX_ATTEMPTS = 15; // 15 × 2s = 30s máximo

    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      attempts++;
      this.log(`[sepius] poll #${attempts} → /active`);
      try {
        const res = await fetch(`${API_BASE}/api/live/${this.channel}/active`);
        const data: { isLive: boolean; hlsUrl: string | null; isReady: boolean } = await res.json();
        this.log(`[sepius] poll #${attempts} ←`, data);

        if (data.isReady && data.hlsUrl) {
          clearInterval(this.pollTimer!);
          this.pollTimer = null;
          const rawUrl = data.hlsUrl.startsWith('/') ? `${API_BASE}${data.hlsUrl}` : data.hlsUrl;
          const fullUrl = rawUrl;
          this.currentHlsUrl = fullUrl;
          this.log(`[sepius] HLS listo tras ${attempts} intento(s). Montando.`);
          void this.mountChosen(fullUrl);
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

  /**
   * Recuperación tras un atasco o un error de red. Saltar siempre al borde del directo vacía el búfer
   * y provoca el siguiente corte (bucle), así que solo se salta si el retraso es grande; si no, se
   * reanuda la carga desde la posición actual.
   */
  private resync(video: HTMLVideoElement, why: string): void {
    const latency = (this.hls as any)?.latency as number | undefined;
    if (latency !== undefined && latency > 25 && Number.isFinite(video.duration)) {
      console.warn(`[hls] ${why}: retraso ${latency.toFixed(0)} s, saltando al live edge`);
      video.currentTime = video.duration - 0.5;
      this.hls?.startLoad(-1);
    } else {
      console.warn(`[hls] ${why}: reanudando sin saltar`);
      this.hls?.startLoad(video.currentTime);
    }
  }

  // ── Elección de calidad ──────────────────────────────────────────────────

  private static lowUrl(sourceUrl: string): string {
    return sourceUrl.replace(/\/index\.m3u8(\?.*)?$/, '/low/index.m3u8$1');
  }

  /** ¿El dispositivo/conexión pide la versión ligera? Móvil, ahorro de datos o red lenta. */
  private prefersLight(): boolean {
    const conn = (navigator as any).connection as
      { saveData?: boolean; effectiveType?: string; downlink?: number } | undefined;
    if (conn?.saveData) return true;
    if (conn?.effectiveType && ['slow-2g', '2g', '3g'].includes(conn.effectiveType)) return true;
    if (typeof conn?.downlink === 'number' && conn.downlink > 0 && conn.downlink < 5) return true;
    const mobile = window.matchMedia?.('(pointer: coarse)').matches && window.innerWidth < 900;
    return !!mobile;
  }

  private async probe(url: string): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Decide original o ligera y monta el reproductor. Si la ligera no existe (Starvios, o aún no está), usa el original. */
  private async mountChosen(sourceUrl: string): Promise<void> {
    this.sourceUrl = sourceUrl;
    const run = this.startRun;

    const lowUrl = DashboardComponent.lowUrl(sourceUrl);
    const lowOk = this.platform() !== 'starvios' && (await this.probe(lowUrl));
    if (run !== this.startRun) return; // llegó una orden más reciente mientras se comprobaba
    this.lowAvailable.set(lowOk);

    const q = this.quality();
    const wantLow = q === 'low' || (q === 'auto' && (this.autoDowngraded || this.prefersLight()));
    const useLow = wantLow && lowOk;

    this.effectiveQuality.set(useLow ? 'low' : 'source');
    this.currentHlsUrl = useLow ? lowUrl : sourceUrl;
    this.log(`[sepius] calidad=${q} → ${useLow ? 'ligera' : 'original'}: ${this.currentHlsUrl}`);
    this.mountHls(this.currentHlsUrl);
  }

  setQuality(q: 'auto' | 'source' | 'low'): void {
    this.qualityMenuOpen.set(false);
    this.autoDowngraded = false;
    this.qualityNotice.set('');
    try { localStorage.setItem('sepius-quality', q); } catch { /* sin almacenamiento: no se recuerda */ }
    this.quality.set(q);
    this.remount();
  }

  /** Vuelve a montar el reproductor con la calidad elegida (sin pedir otra vez el estado al servidor). */
  private remount(): void {
    if (!this.sourceUrl) return;
    this.stopHls();
    this.status.set('loading');
    void this.mountChosen(this.sourceUrl);
  }

  /** Varios atascos seguidos con el original en «auto»: se pasa a la ligera y se avisa. */
  private noteStall(): void {
    if (this.quality() !== 'auto' || this.effectiveQuality() !== 'source' || !this.lowAvailable()) return;
    const now = Date.now();
    this.stallTimes = [...this.stallTimes.filter(t => now - t < 60_000), now];
    if (this.stallTimes.length < 3) return;

    this.stallTimes = [];
    this.autoDowngraded = true;
    this.qualityNotice.set('Tu conexión va justa: he cambiado a calidad ligera. Puedes elegirla en «Calidad».');
    setTimeout(() => this.qualityNotice.set(''), 9000);
    this.remount();
  }

  private mountHls(hlsUrl: string): void {
    const video = this.videoRef.nativeElement;

    if (Hls.isSupported()) {
      let mediaRecoveryAttempted = false;

      this.hls = new Hls({
        // Empezar siempre en el borde live (-1 = último segmento)
        startPosition: -1,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 0,
        // Poco margen sobre el borde live (3 segmentos ≈ 12 s) para que el vídeo vaya lo más cerca posible del
        // chat. Si se acumula retraso (tras un tirón de red), se recupera acelerando un poco (hasta x1,08)
        // en lugar de saltar.
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
        maxLiveSyncPlaybackRate: 1.08,
        // Timeouts cortos con reintentos rápidos: una conexión perdida suele funcionar al reintentar
        // a los pocos segundos; esperar 15-30 s dejaba el vídeo parado.
        manifestLoadingTimeOut: 8000,
        manifestLoadingMaxRetry: 6,
        manifestLoadingRetryDelay: 500,
        levelLoadingTimeOut: 5000,
        levelLoadingMaxRetry: 8,
        levelLoadingRetryDelay: 500,
        fragLoadingTimeOut: 10000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 500,
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
        this.log('[sepius] MANIFEST_PARSED → reproduciendo desde el live edge.');
        // No forzar el salto al final: hls.js ya arranca a liveSyncDurationCount segmentos del borde,
        // y saltar al último segmento dejaba el búfer vacío (el primer bajón de red cortaba el vídeo).
        this.status.set('playing');
        this.reconnectAttempts = 0;
        this.isAtLiveEdge.set(true);
        this.startLiveCheck();
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
          if (!video.paused && this.hls) this.resync(video, 'Stall detectado');
        }, this.STALL_TIMEOUT_MS);
      };

      this.addVideoListener(video, 'waiting', resetStallTimer);
      this.addVideoListener(video, 'waiting', () => this.noteStall());
      this.addVideoListener(video, 'stalled', resetStallTimer);
      this.addVideoListener(video, 'playing', () => {
        if (this.stallTimer) clearTimeout(this.stallTimer);
      });

      // Detectar si el usuario se ha alejado del borde live
      this.addVideoListener(video, 'timeupdate', () => {
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
          this.resync(video, `Frag error (non-fatal) ${data.details}`);
          return;
        }

        if (!data.fatal) return;

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            this.resync(video, `Network error fatal ${data.details}`);
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
      // Reproductor nativo (Safari/iPhone sin hls.js): sin reconexión propia, así que se gestiona aquí.
      video.src = hlsUrl;
      this.addVideoListener(video, 'loadedmetadata', () => {
        this.status.set('playing');
        this.reconnectAttempts = 0;
        video.play().catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'NotAllowedError') this.needsInteraction.set(true);
        });
      });
      this.addVideoListener(video, 'error', () => {
        this.status.set('error');
        this.errorMsg.set('Error de stream HLS. Reconectando...');
        this.scheduleReconnect();
      });
      this.addVideoListener(video, 'waiting', () => {
        if (this.stallTimer) clearTimeout(this.stallTimer);
        this.stallTimer = setTimeout(() => {
          if (!video.paused && video.readyState < 3) this.startStream();
        }, this.STALL_TIMEOUT_MS * 2);
      });
      this.addVideoListener(video, 'playing', () => {
        if (this.stallTimer) clearTimeout(this.stallTimer);
      });
    }
  }

  private startLiveCheck(): void {
    this.stopLiveCheck();
    this.liveCheckTimer = setInterval(async () => {
      if (this.status() !== 'playing') {
        this.stopLiveCheck();
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/api/live/${this.channel}/active`);
        if (!res.ok) return;
        const data: { isLive: boolean } = await res.json();
        if (!data.isLive) {
          console.warn('[sepius] Stream ya no en vivo (detectado por polling).');
          this.stopLiveCheck();
          this.stopHls();
          this.status.set('error');
          this.errorMsg.set(`${this.channel} ha terminado el directo.`);
        }
      } catch {
        // Ignorar errores de red en el check
      }
    }, this.LIVE_CHECK_INTERVAL_MS);
  }

  private stopLiveCheck(): void {
    if (this.liveCheckTimer) {
      clearInterval(this.liveCheckTimer);
      this.liveCheckTimer = null;
    }
  }

  /** Solo para fallos reales (API caída, error de vídeo): una cola, con espera creciente 10s → 60s. */
  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = Math.min(this.RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts, this.RECONNECT_MAX_MS);
    this.reconnectAttempts++;

    this.reconnectCountdown.set(Math.round(delay / 1000));
    this.countdownInterval = setInterval(() =>
      this.reconnectCountdown.update(v => Math.max(0, v - 1)), 1000);

    this.reconnectTimer = setTimeout(() => {
      this.clearReconnect();
      // Con la pestaña oculta no se gasta red: se reconecta al volver a verla.
      if (document.hidden) {
        this.reconnectPending = true;
        return;
      }
      this.startStream();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.countdownInterval) { clearInterval(this.countdownInterval); this.countdownInterval = null; }
    this.reconnectPending = false;
  }

  private addVideoListener(video: HTMLVideoElement, type: string, fn: EventListener): void {
    video.addEventListener(type, fn);
    this.videoListeners.push([type, fn]);
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

  /** Segundos que se va por detrás del borde live: el clip debe terminar donde el espectador está viendo. */
  behindSeconds = (): number => {
    const v = this.hls?.latency;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  };

  jumpToLive(): void {
    const video = this.videoRef?.nativeElement;
    if (video && Number.isFinite(video.duration)) {
      video.currentTime = video.duration;
      video.play();
    }
    this.isAtLiveEdge.set(true);
  }

  reconnectNow(): void {
    this.reconnectAttempts = 0;
    this.startStream();
  }

  castStream(): void {
    if (this.cast.isCasting()) {
      this.cast.stopCasting();
      return;
    }
    if (this.sourceUrl || this.currentHlsUrl) {
      this.cast.castHls(this.sourceUrl || this.currentHlsUrl, `${this.channel} - ${this.platform() ?? 'live'}`);
    }
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;
    const video = this.videoRef?.nativeElement;
    if (this.status() === 'error' || this.reconnectPending) {
      this.reconnectNow();
    } else if (video?.paused) {
      video.play().catch(() => {});
    }
  };

  private stopHls(): void {
    this.stopLiveCheck();
    this.hls?.destroy();
    this.hls = null;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
    // Resetear el elemento <video> para eliminar cualquier MediaSource residual
    const video = this.videoRef?.nativeElement;
    if (video) {
      for (const [type, fn] of this.videoListeners) video.removeEventListener(type, fn);
      this.videoListeners = [];
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }

  ngOnDestroy(): void {
    this.startRun++; // invalida cualquier startStream en vuelo
    this.stopHls();
    this.clearReconnect();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }
}
