import { test } from 'node:test';
import { bundleScenarios } from './deadline-wiki-bundle-scenarios.js';
test('SQLite: atomic multi-page replacement lineage and HTTP projections', { timeout: 120000 }, () => bundleScenarios('legacy'));
