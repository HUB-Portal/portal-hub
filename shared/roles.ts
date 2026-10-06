export const PARTNER_ROLES = ['admin', 'uploader', 'quality', 'finance', 'viewer'] as const;
export const KLINE_ROLES = ['kl_admin', 'kl_intake', 'kl_production', 'kl_quality', 'kl_finance'] as const;
export const ALL_ROLES = [...PARTNER_ROLES, ...KLINE_ROLES] as const;
export type Role = (typeof ALL_ROLES)[number];

export const PERMISSIONS = [
  'case.read', 'case.write', 'case.reveal_name', 'case.erase', 'file.download',
  'claim.read', 'claim.write', 'claim.decide', 'spec.read', 'spec.edit', 'spec.sign',
  'material.read', 'material.declare', 'material.manage', 'material.receive',
  'org.read', 'org.edit', 'org.logo', 'team.manage', 'integration.manage', 'export.run', 'audit.read',
  'intake.manage', 'stage.manual', 'admin.partners', 'admin.sites', 'admin.staff', 'admin.mes',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const P = (s: string): Permission[] => s.split(' ').filter(Boolean) as Permission[];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: P('case.read case.write case.reveal_name case.erase file.download claim.read claim.write spec.read spec.edit spec.sign material.read material.declare material.manage org.read org.edit org.logo team.manage integration.manage export.run audit.read'),
  uploader: P('case.read case.write case.reveal_name file.download claim.read spec.read material.read material.declare org.read org.logo'),
  quality: P('case.read case.reveal_name file.download claim.read claim.write spec.read spec.edit spec.sign material.read org.read org.logo'),
  finance: P('case.read claim.read spec.read material.read org.read org.logo export.run'),
  viewer: P('case.read claim.read spec.read material.read org.read'),
  kl_admin: [...PERMISSIONS],
  kl_intake: P('case.read case.write case.reveal_name file.download claim.read spec.read material.read org.read intake.manage stage.manual export.run'),
  kl_production: P('case.read case.reveal_name file.download claim.read spec.read material.read material.receive org.read stage.manual'),
  kl_quality: P('case.read case.reveal_name file.download claim.read claim.write claim.decide spec.read spec.sign material.read org.read'),
  kl_finance: P('case.read claim.read spec.read material.read org.read export.run'),
};

export const PARTNER_API_SCOPES = ['cases:read', 'cases:write', 'patients:read', 'claims:read', 'materials:read'] as const;
export const KLINE_API_SCOPES = ['mes:intake', 'mes:files', 'mes:events'] as const;

export function permissionsFor(roles: readonly string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r as Role] ?? []) out.add(p);
  return out;
}
export function can(roles: readonly string[], perm: Permission): boolean {
  return permissionsFor(roles).has(perm);
}
export function isKlineRole(role: string): boolean {
  return (KLINE_ROLES as readonly string[]).includes(role);
}
