import { useEffect, useState } from 'react';
import { logoUrl } from '../lib/orgApi';

/**
 * The company logo, loaded with the session cookie from /api/org/logo. When the image cannot be loaded the component
 * renders nothing, so the page falls back to the plain company name. `src` replaces the address, for previews.
 */
export function OrgLogoImage({ name, version, src, className = 'topbar-logo', onFailed }: { name: string; version?: string; src?: string; className?: string; onFailed?: () => void }) {
  const url = src ?? logoUrl(version ?? '0');
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (failed) return null;
  return <img className={className} src={url} alt={`${name} logo`} loading="eager" decoding="async" onError={() => { setFailed(true); onFailed?.(); }} />;
}
