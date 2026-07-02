import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          workers: [
            {
              name: 'payrail',
              modules: true,
              script: 'export default { fetch() { return new Response("mock_payrail"); } }'
            }
          ]
        }
      },
    },
  },
});
