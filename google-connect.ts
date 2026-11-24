import type { OAuthCredential, Provider } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { mutateProxyAuthAsync } from './auth-file-transaction.ts';

const googleSlot = (id: string) => /^google-antigravity(?:-account-[1-9]\d*)?$/.test(id);

/** New connections only: never replace a login/refresh won by another process. */
export async function persistGoogleConnection(authPath: string, sidecarPath: string, provider: string, credential: OAuthCredential, signal: AbortSignal): Promise<void> {
 if (!googleSlot(provider) || credential.type !== 'oauth' || typeof credential.accountId !== 'string' || !/^google:\d+$/.test(credential.accountId)) {
  throw new Error('Invalid Google connection identity');
 }
 await mutateProxyAuthAsync(authPath,sidecarPath,async(auth,sidecar,lockedSignal)=>{
  lockedSignal.throwIfAborted();
  if (auth[provider] || sidecar[provider]) throw new Error('Google account slot is occupied; existing connection preserved');
  for (const [id, entry] of [...Object.entries(auth), ...Object.entries(sidecar)]) {
   if (googleSlot(id) && entry.accountId === credential.accountId) throw new Error('Google account is already connected');
  }
  auth[provider]=credential;
  return {auth,sidecar,changed:true};
 },'restore',{signal});
}

function checkGoogleAuthorizationURL(url: string): void {
 const parsed = new URL(url);
 if (parsed.href !== url || parsed.origin !== 'https://accounts.google.com' || parsed.pathname !== '/o/oauth2/v2/auth' || parsed.username || parsed.password || parsed.hash) throw new Error('Unexpected Google authorization URL');
}

/** Open the OS default browser, never an empty profile or a debugging browser. */
export function googleBrowserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
 checkGoogleAuthorizationURL(url);
 if (platform === 'darwin') return ['open', [url]];
 if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
 if (platform === 'linux') return ['xdg-open', [url]];
 throw new Error('Automatic browser opening is unavailable on this platform');
}

type GoogleProvider = Provider & { quotaSnapshot(): { updatedAt: number; models: { id: string; remaining?: number; reset?: string }[] } };
type Options = {
 authPath: string;
 sidecarPath: string;
 accounts(): Record<string, unknown>;
 providers(): ReadonlyMap<string, GoogleProvider>;
};

/** One account-facing entrypoint; service credentials and allowances stay separate. */
export function registerGoogleConnection(pi: ExtensionAPI, options: Options): void {
 let active: AbortController | undefined;
 let pending: Promise<void> | undefined;
 const show = (ctx: ExtensionCommandContext) => {
  const accounts = options.accounts();
  const lines = ['Google connections — service allowances are not added together:'];
  for (const [id, provider] of options.providers()) {
   if (!accounts[id]) continue;
   const snapshot = provider.quotaSnapshot();
   lines.push(`${id}: saved connection; ${snapshot.models.length} catalog models; observed ${snapshot.updatedAt ? new Date(snapshot.updatedAt).toISOString() : 'unknown'}`);
   for (const model of snapshot.models) lines.push(`  ${model.id}: ${model.remaining === undefined ? 'remaining quota unknown' : `${Math.round(model.remaining * 100)}% remaining`}; reset ${model.reset ?? 'unknown'}`);
  }
  if (lines.length === 1) lines.push('Antigravity: not connected.');
  lines.push('AI Studio web allowance: not connected by this integration yet; no plan eligibility is inferred.',
   'Gemini CLI / Code Assist: not connected by this integration yet; these are not two independent quota pools.',
   'Gemini API / Cloud credits: separate billing; this flow does not enable or change them.',
   'Saved catalogs are observations, not proof of current entitlement or a successful model request.');
  ctx.ui.notify(lines.join('\n'), 'info');
 };
 const run = async (args: string, ctx: ExtensionCommandContext, controller: AbortController) => {
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000), ...(ctx.signal ? [ctx.signal] : [])]);
  let action = args;
  if (!action) {
   if (!ctx.hasUI) { show(ctx); return; }
   action = (await ctx.ui.select('Google account', ['Connect Google account', 'Refresh connected services', 'Show connections'], {signal})) ?? '';
   signal.throwIfAborted();
   action = ({'Connect Google account':'connect', 'Refresh connected services':'refresh', 'Show connections':'status'} as Record<string,string>)[action] ?? '';
  }
  if (!action) return;
  if (action === 'status') { show(ctx); return; }
  if (action === 'refresh') {
   const accounts = options.accounts();
   const ids = [...options.providers().keys()].filter(id => accounts[id]);
   if (!ids.length) { show(ctx); return; }
   const result = await ctx.modelRegistry.refresh({providers: ids, allowNetwork: true, force: true, signal});
   signal.throwIfAborted();
   if (result.errors.size) ctx.ui.notify('Some Google services could not be refreshed. Retained observations may be stale; no extra allowance was inferred.', 'warning');
   show(ctx); return;
  }
  if (!ctx.hasUI) { ctx.ui.notify('Google browser sign-in requires interactive Pi.', 'warning'); return; }
  const accounts = options.accounts();
  const slot = [...options.providers()].find(([id]) => !accounts[id]);
  if (!slot) { ctx.ui.notify('All Google account slots are occupied. Existing connections were preserved.', 'warning'); return; }
  const [id, provider] = slot;
  const oauth = provider.auth.oauth;
  if (!oauth) throw new Error('Browser sign-in unavailable');
  ctx.ui.notify('Connect Google in your usual browser. This version connects Antigravity only; Studio and other services are not automatically authorized. No passwords, passkeys or browser cookies are read by this command.', 'info');
  const browserTasks: Promise<void>[] = [];
  try {
   const credential = await oauth.login({
    signal,
    notify(event) {
     if (signal.aborted) return;
     if (event.type === 'auth_url') {
      // Only an already validated destination may be displayed if the OS launch fails.
      checkGoogleAuthorizationURL(event.url);
      const task = (async () => {
       try {
        signal.throwIfAborted();
        const [command, argv] = googleBrowserCommand(event.url);
        const result = await pi.exec(command, argv, {signal, timeout: 10000});
        if (result.code !== 0) throw new Error('Browser launch failed');
       } catch {
        if (!signal.aborted) ctx.ui.notify(`Open this Google sign-in link in your usual browser:\n${event.url}`, 'warning');
       }
      })();
      browserTasks.push(task);
     } else if (event.type === 'info' || event.type === 'progress') ctx.ui.notify(event.message, 'info');
    },
    async prompt(request) {
     const promptSignal = AbortSignal.any([signal, ...(request.signal ? [request.signal] : [])]);
     promptSignal.throwIfAborted();
     if (request.type === 'secret') throw new Error('Google credentials must be entered in the browser, not Pi');
     let value: string | undefined;
     if (request.type === 'select') {
      const selected = await ctx.ui.select(request.message, request.options.map(item => item.label), {signal: promptSignal});
      value = request.options.find(item => item.label === selected)?.id;
     } else value = await ctx.ui.input(request.message, request.placeholder, {signal: promptSignal});
     // A successful browser callback cancels only its manual-code dialog, not the login.
     promptSignal.throwIfAborted();
     if (value === undefined) { controller.abort(); throw new Error('Google sign-in cancelled'); }
     return value;
    },
   });
   signal.throwIfAborted();
   await persistGoogleConnection(options.authPath, options.sidecarPath, id, credential, signal);
   const result = await ctx.modelRegistry.refresh({providers: [id], allowNetwork: false, signal});
   signal.throwIfAborted();
   ctx.ui.notify(result.errors.size ? 'Google authorization saved, but model discovery in Pi could not be refreshed. Use /google refresh.' : 'Antigravity connection saved. Discovered models are available in /model. Other Google services remain separate.', result.errors.size ? 'warning' : 'info');
   show(ctx);
  } finally { await Promise.allSettled(browserTasks); }
 };
 pi.registerCommand('google', {
  description: 'Connect Google in your usual browser; inspect or refresh separate service availability',
  handler: async (args, ctx) => {
   const action = args.trim();
   if (!['', 'connect', 'refresh', 'status'].includes(action)) { ctx.ui.notify('Usage: /google [connect|refresh|status]', 'warning'); return; }
   if (active) { ctx.ui.notify('A Google connection operation is already in progress.', 'warning'); return; }
   const controller = new AbortController(); active = controller;
   pending = run(action, ctx, controller);
   try { await pending; }
   catch { if (!controller.signal.aborted && !ctx.signal?.aborted) ctx.ui.notify('Google connection operation did not complete. Existing connections were not removed; no paid API fallback was enabled. Use /google status to inspect saved connections.', 'warning'); }
   finally { controller.abort(); active = undefined; pending = undefined; }
  },
 });
 pi.on('session_shutdown', async () => { active?.abort(); await pending?.catch(() => {}); });
}
