import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const root = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  // PGlite loads its own wasm at runtime; pg has optional native bindings.
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  turbopack: { root },
  outputFileTracingRoot: root,
  devIndicators: false,
};

export default config;
