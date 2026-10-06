import { Link } from 'react-router-dom';
import { homeFor, useAuth } from '../../lib/auth';
import { usePublicConfig } from '../../lib/orgApi';
import { GettingStarted } from '../shared/GettingStarted';
import { AuthLayout } from './AuthLayout';

export default function GettingStartedPublic() {
  const { me } = useAuth();
  const config = usePublicConfig();
  const signedIn = me?.stage === 'full';
  return (
    <AuthLayout title="Getting started" xwide>
      <GettingStarted />
      <div className="row">
        {signedIn ? <Link className="btn btn-primary" to={homeFor(me)}>Go to the portal</Link> : (
          <>
            {config.data?.signupEnabled ? <Link className="btn btn-primary" to="/register">Register your company</Link> : null}
            <Link className={config.data?.signupEnabled ? 'btn' : 'btn btn-primary'} to="/login">Sign in</Link>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
