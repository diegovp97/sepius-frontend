import { ActivatedRouteSnapshot, CanActivateFn, Router, RouterStateSnapshot } from '@angular/router';
import { inject } from '@angular/core';
import { authGuard } from './auth.guard';

/**
 * /mod: pide el usuario y la contraseña de admin (los mismos que /youtube) y vuelve al directo.
 * Con la sesión iniciada, el chat muestra el botón de borrar mensajes.
 */
export const modGuard: CanActivateFn = async (route: ActivatedRouteSnapshot, state: RouterStateSnapshot) => {
  const router = inject(Router);
  await authGuard(route, state);
  return router.createUrlTree(['/']);
};
