import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core';
import { environment } from '../../environments/environment';
import { getToken, getUser, setToken } from '../services/auth';

/** Panel de grabaciones/YouTube: solo para la cuenta de administrador. */
export const authGuard: CanActivateFn = async () => {
  const router = inject(Router);

  if (getToken()) {
    if (getUser()?.role === 'admin') return true;
    alert('Esta sección es solo para el administrador.');
    return router.createUrlTree(['/']);
  }

  const username = prompt('Usuario:');
  if (!username) return router.createUrlTree(['/']);

  const password = prompt('Contraseña:');
  if (!password) return router.createUrlTree(['/']);

  try {
    const res = await fetch(`${environment.apiUrl}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.role !== 'admin') {
        alert('Esta sección es solo para el administrador.');
        return router.createUrlTree(['/']);
      }
      setToken(data.token);
      return true;
    }

    alert(res.status === 429 ? 'Demasiados intentos. Espera un minuto.' : 'Credenciales incorrectas.');
    return router.createUrlTree(['/']);
  } catch {
    alert('Error de conexión con el servidor.');
    return router.createUrlTree(['/']);
  }
};
