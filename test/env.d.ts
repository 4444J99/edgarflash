declare module 'cloudflare:test' {
  interface ProvidedEnv {
    ASSETS: Fetcher;
    EF_STATE: KVNamespace;
    EF_SUBS: KVNamespace;
    USER_AGENT: string;
    PAYRAIL?: Fetcher;
    PAYRAIL_URL?: string;
  }
}
