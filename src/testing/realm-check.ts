import { AccessPolicy, TENANT_ADMIN_PERMISSIONS, TENANT_GROUPS } from '../access/access-policy';

/** A Keycloak role as a realm export writes it. */
export interface RealmRole { name: string; composite?: boolean; composites?: { client?: Record<string, string[]> } }
/** The parts of a Keycloak realm export the checks read. */
export interface RealmJson {
  roles?: { realm?: RealmRole[]; client?: Record<string, RealmRole[]> };
  clientScopes?: unknown;
  organizations?: { alias?: string; groups?: { name: string; clientRoles?: Record<string, string[]> }[] }[];
}

const sorted = (xs: Iterable<string>) => [...xs].sort();
const same = (a: Iterable<string>, b: Iterable<string>) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/**
 * Checks that a realm template (the product's realm-base.json, given to `@helix-x/kc-realm-generator`) defines
 * exactly what the policy checks:
 * - the api client's plain roles are the policy's permissions, and its composite roles are the three bundles;
 * - bundles hold only known, non-platform permissions;
 * - tenant-admin holds every service and tenant-admin permission;
 * - the realm role platform-admin holds every platform permission and tenant-admin.
 *
 * Returns the problems found (empty = consistent). Framework-free, so a product's test is one line:
 * `expect(checkRealmTemplate(realm, policy, 'acme-org-api')).toEqual([])`.
 */
export function checkRealmTemplate(realm: RealmJson, policy: AccessPolicy, apiClientId: string): string[] {
  const problems: string[] = [];
  const roles = realm.roles?.client?.[apiClientId];
  if (!roles) return [`realm has no client roles for ${apiClientId}`];
  const role = (name: string) => roles.find((r) => r.name === name);
  const contents = (r: RealmRole | undefined) => r?.composites?.client?.[apiClientId] ?? [];
  const bundles = Object.values(TENANT_GROUPS);

  const plain = roles.filter((r) => !r.composite).map((r) => r.name);
  if (!same(plain, policy.permissions)) {
    const missing = policy.permissions.filter((p) => !plain.includes(p));
    const extra = plain.filter((p) => !policy.permissions.includes(p));
    problems.push(`${apiClientId} roles differ from the policy: missing [${missing.join(', ')}], not in the policy [${extra.join(', ')}]`);
  }
  const composite = roles.filter((r) => r.composite).map((r) => r.name);
  if (!same(composite, bundles)) problems.push(`${apiClientId} composite roles should be ${bundles.join(', ')}, got ${composite.join(', ')}`);

  for (const b of bundles) {
    for (const p of contents(role(b))) {
      if (!policy.permissions.includes(p)) problems.push(`bundle ${b} holds unknown permission ${p}`);
      else if ((policy.platformPermissions as readonly string[]).includes(p)) problems.push(`bundle ${b} holds platform permission ${p}`);
    }
  }
  const adminWants = [...policy.servicePermissions, ...TENANT_ADMIN_PERMISSIONS];
  if (!same(contents(role('tenant-admin')), adminWants)) problems.push(`tenant-admin should hold exactly ${sorted(adminWants).join(', ')}`);

  const platform = realm.roles?.realm?.find((r) => r.name === 'platform-admin');
  const platformWants = [...policy.platformPermissions, 'tenant-admin'];
  if (!same(contents(platform), platformWants)) problems.push(`platform-admin should hold exactly ${sorted(platformWants).join(', ')}`);
  return problems;
}

/**
 * Checks a realm generated from the template (e.g. the committed dev sample): it carries the template's roles
 * and client scopes unchanged, and every organization maps admins / members / viewers to their bundles.
 */
export function checkGeneratedRealm(generated: RealmJson, template: RealmJson, apiClientId: string): string[] {
  const problems: string[] = [];
  if (JSON.stringify(generated.roles) !== JSON.stringify(template.roles)) problems.push('roles differ from the template (regenerate the realm)');
  if (JSON.stringify(generated.clientScopes) !== JSON.stringify(template.clientScopes)) problems.push('client scopes differ from the template (regenerate the realm)');
  const want = JSON.stringify(Object.fromEntries(Object.entries(TENANT_GROUPS).map(([g, b]) => [g, [b]])));
  for (const org of generated.organizations ?? []) {
    const groups = Object.fromEntries((org.groups ?? []).map((g) => [g.name, g.clientRoles?.[apiClientId]]));
    const ordered = JSON.stringify(Object.fromEntries(Object.keys(TENANT_GROUPS).map((g) => [g, groups[g]])));
    if (ordered !== want || Object.keys(groups).length !== Object.keys(TENANT_GROUPS).length) {
      problems.push(`organization ${org.alias ?? '?'} does not map ${Object.keys(TENANT_GROUPS).join(' / ')} to their bundles`);
    }
  }
  return problems;
}
