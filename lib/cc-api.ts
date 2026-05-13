import { ProxyAgent } from 'undici';

const CC_API = 'https://api.checkoutchamp.com';

function getProxy(): ProxyAgent | undefined {
  return process.env.FIXIE_URL ? new ProxyAgent(process.env.FIXIE_URL) : undefined;
}

function getCreds() {
  const loginId = process.env.CC_LOGIN_ID;
  const password = process.env.CC_PASSWORD;
  if (!loginId || !password) throw new Error('CC_LOGIN_ID or CC_PASSWORD not set');
  return { loginId, password };
}

export async function ccApiCall(endpoint: string, params: Record<string, any>): Promise<any> {
  const dispatcher = getProxy();
  const creds = getCreds();
  const isFulfillment = endpoint.startsWith('fulfillment');

  if (isFulfillment) {
    const body = new URLSearchParams({
      loginId: creds.loginId,
      password: creds.password,
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    });
    const resp = await fetch(`${CC_API}/${endpoint}/`, {
      method: 'POST',
      body,
      ...(dispatcher ? { dispatcher } : {}),
    } as any);
    return resp.json();
  }

  const url = new URL(`${CC_API}/${endpoint}/`);
  url.searchParams.set('loginId', creds.loginId);
  url.searchParams.set('password', creds.password);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url.toString(), dispatcher ? { dispatcher } as any : {});
  return resp.json();
}
