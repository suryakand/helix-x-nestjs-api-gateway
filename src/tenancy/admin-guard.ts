
/**
 * Pure checks that keep the gateway from being a confused deputy: it calls Keycloak's admin API with a powerful
 * service account, so every grant an admin makes through it must stay within what that admin holds.
 * Each returns an error message, or null when allowed.
 */

/** Putting someone in a group (or taking them out of one) needs every permission that group's bundle grants. */
export function checkGroupChange(actor: string[], bundles: string[][]): string | null {
  const missing = [...new Set(bundles.flat())].filter((p) => !actor.includes(p));
  return missing.length ? `you cannot assign or change a group with permissions you don't hold: ${missing.join(', ')}` : null;
}

/** M2M clients get service permissions only, and only ones the admin holds in this tenant. */
export function checkClientPermissions(actor: string[], requested: string[], isServicePermission: (p: string) => boolean): string | null {
  const notService = requested.filter((p) => !isServicePermission(p));
  if (notService.length) return `clients can only hold service permissions, not ${notService.join(', ')}`;
  const missing = requested.filter((p) => !actor.includes(p));
  return missing.length ? `you cannot grant permissions you don't hold: ${missing.join(', ')}` : null;
}

/** A tenant must keep at least one admin, or nobody but a platform admin could manage it. */
export function checkKeepsAdmin(adminsNow: string[], target: string, targetStaysAdmin: boolean): string | null {
  if (targetStaysAdmin || !adminsNow.includes(target)) return null;
  return adminsNow.length <= 1 ? 'a tenant needs at least one admin' : null;
}
