const TOKEN_KEY = 'sepius_token';

/** Devuelve el JWT guardado si no ha caducado; si no, lo borra y devuelve null. */
export function getToken(): string | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return null;
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now() + 30_000) {
      clearToken();
      return null;
    }
    return token;
  } catch {
    clearToken();
    return null;
  }
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** fetch con la cabecera Authorization. Si la API responde 401, borra el token. */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    clearToken();
    throw new Error('Sesión caducada: vuelve a iniciar sesión (recarga la página).');
  }
  return res;
}

/** Para <video src> y enlaces de descarga, que no pueden enviar cabeceras. */
export function withToken(url: string): string {
  const token = getToken();
  return token ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}` : url;
}

// ── Cuentas ────────────────────────────────────────────────────────────────

export type Role = 'user' | 'moderator' | 'admin';
export interface SessionUser { name: string; role: Role; }

const CLAIM_NAME = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name';
const CLAIM_ROLE = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role';

/** Usuario de la sesión actual (leído del JWT, solo para mostrar la interfaz: el servidor valida el permiso real). */
export function getUser(): SessionUser | null {
  const token = getToken();
  if (!token) return null;
  try {
    const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const name = p[CLAIM_NAME] ?? p['unique_name'] ?? p['name'];
    const role = (p[CLAIM_ROLE] ?? p['role'] ?? 'user') as Role;
    return name ? { name, role } : null;
  } catch {
    return null;
  }
}

export function isStaff(user: SessionUser | null): boolean {
  return user?.role === 'admin' || user?.role === 'moderator';
}

export function logout(): void {
  clearToken();
}

/** Inicia sesión o crea la cuenta. Devuelve null si todo fue bien, o el mensaje de error para mostrar. */
export async function authenticate(
  apiUrl: string, mode: 'login' | 'register', username: string, password: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${apiUrl}/api/auth/${mode === 'login' ? 'verify' : 'register'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.trim(), password }),
    });
    if (res.ok) {
      setToken((await res.json()).token);
      return null;
    }
    if (res.status === 429) return 'Demasiados intentos. Espera unos minutos.';
    if (res.status === 401) return 'Usuario o contraseña incorrectos.';
    const body = await res.json().catch(() => null);
    return body?.error ?? 'No se pudo completar la operación.';
  } catch {
    return 'Error de conexión con el servidor.';
  }
}
