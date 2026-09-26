import { Resend } from 'resend';
import { env, isDev } from './env.js';

/* Outbound email.

   Every send goes through here, so the sender address, the failure handling
   and the plain text fallback are decided once. Templates are inline rather
   than in a template engine: there are three of them and they are short, and a
   template engine for three emails is a dependency that earns nothing. */

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

type Mail = { to: string; subject: string; html: string; text: string };

/* A failed email must never fail the request that triggered it. If a reset
   email bounces, the reset itself still happened, and telling the user their
   password reset failed would be a lie. Errors are logged and swallowed. */
async function send(mail: Mail): Promise<boolean> {
  if (!resend) {
    if (isDev) console.log(`[dev] no RESEND_API_KEY, would have emailed ${mail.to}: ${mail.subject}`);
    return false;
  }
  try {
    const { error } = await resend.emails.send({
      from: env.EMAIL_FROM,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    if (error) {
      console.error(`Email to ${mail.to} rejected by Resend:`, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Email to ${mail.to} failed:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/* One wrapper so every email looks the same and none of them carry an image,
   a tracking pixel or a webfont. Plain, fast, and it renders in every client. */
const layout = (heading: string, body: string, button?: { label: string; url: string }) => `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#142539">
  <p style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#5f7590;margin:0 0 18px">Variantage Finance</p>
  <h1 style="font-size:22px;margin:0 0 16px">${heading}</h1>
  ${body}
  ${
    button
      ? `<p style="margin:26px 0"><a href="${button.url}" style="display:inline-block;background:#142539;color:#fff;text-decoration:none;padding:13px 26px;border-radius:999px;font-weight:700">${button.label}</a></p>
         <p style="font-size:13px;color:#5f7590;margin:0">If the button does not work, paste this into your browser:<br>${button.url}</p>`
      : ''
  }
  <p style="font-size:12px;color:#5f7590;border-top:1px solid #e8eff7;margin-top:28px;padding-top:16px">
    Variantage Finance, Ontario, Canada. If you were not expecting this, you can ignore it.
  </p>
</div>`;

export function sendPasswordReset(to: string, token: string): Promise<boolean> {
  const url = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  return send({
    to,
    subject: 'Reset your Variantage password',
    html: layout(
      'Set a new password',
      `<p style="font-size:15px;line-height:1.6">Someone asked to reset the password for this account.
       The link works once and expires in 60 minutes.</p>
       <p style="font-size:15px;line-height:1.6">Nothing in your books changes by resetting a password.</p>`,
      { label: 'Set a new password', url },
    ),
    text: `Set a new password: ${url}\n\nThe link works once and expires in 60 minutes. If you did not ask for this, ignore it.`,
  });
}

export function sendMemberInvite(
  to: string,
  token: string,
  businessName: string,
  invitedBy: string,
): Promise<boolean> {
  const url = `${env.APP_URL}/accept-invite?token=${encodeURIComponent(token)}`;
  return send({
    to,
    subject: `${invitedBy} added you to ${businessName} on Variantage`,
    html: layout(
      `You have been added to ${businessName}`,
      `<p style="font-size:15px;line-height:1.6">${invitedBy} has given you access to the books for
       <strong>${businessName}</strong>. Choose your own password to get in. The link expires in seven days.</p>`,
      { label: 'Choose a password', url },
    ),
    text: `${invitedBy} added you to ${businessName} on Variantage. Choose a password: ${url}\n\nThe link expires in seven days.`,
  });
}
