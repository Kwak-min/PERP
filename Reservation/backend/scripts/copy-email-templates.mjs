import { cp } from 'node:fs/promises';

await cp(
  new URL('../src/notification/templates/', import.meta.url),
  new URL('../dist/notification/templates/', import.meta.url),
  { recursive: true },
);
