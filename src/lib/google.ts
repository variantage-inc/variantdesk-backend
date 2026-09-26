import crypto from 'node:crypto';
import { env } from './env.js';

/* Continue with Google, by hand rather than through a library.

   The server side authorization code flow is three HTTP calls and a redirect.
   A library would add a dependency, its own opinions about sessions, and a
   surface to keep patched, to save about forty lines. */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const googleConfigured = (): boolean =>
  Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

/* The state parameter is the CSRF defence. We mint a random value, keep it in
   a short lived cookie, and refuse any callback whose state does not match.
   Without it, an attacker can hand a victim a callback URL carrying the
   attacker's code and silently link the two accounts. */
export const newState = (): string => crypto.randomBytes(16).toString('base64url');

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID as string,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    /* Only what we need to know who this is. Anything more would put the app
       through Google's verification review and ask customers to grant access
       they have no reason to give. */
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export type GoogleIdentity = {
  googleId: string;
  email: string;
  emailVerified: boolean;
  firstName: string;
  lastName: string;
  avatarUrl?: string;
};

/* The id_token is a JWT signed by Google. It is not verified here, and that is
   deliberate rather than an oversight: it did not arrive from the browser, it
   came back over TLS from Google's own token endpoint in a request that proved
   our client secret. Nothing untrusted touched it, so there is no signature to
   check that TLS has not already established. */
function readIdToken(idToken: string): GoogleIdentity {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('Google returned a token we could not read.');

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    sub: string;
    email: string;
    email_verified?: boolean;
    given_name?: string;
    family_name?: string;
    name?: string;
    picture?: string;
  };

  const fallback = (claims.name ?? claims.email).split(' ');

  return {
    /* The stable subject id, never the email. A Google email can be changed or
       reassigned to a different person; the subject id cannot. */
    googleId: claims.sub,
    email: claims.email.toLowerCase(),
    emailVerified: claims.email_verified === true,
    firstName: claims.given_name ?? fallback[0] ?? 'There',
    lastName: claims.family_name ?? fallback.slice(1).join(' ') ?? '',
    avatarUrl: claims.picture,
  };
}

export async function exchangeCode(code: string): Promise<GoogleIdentity> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID as string,
      client_secret: env.GOOGLE_CLIENT_SECRET as string,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google rejected the sign in code: ${detail.slice(0, 200)}`);
  }

  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new Error('Google did not return an identity token.');

  return readIdToken(body.id_token);
}
