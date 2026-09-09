import { protectedPorts } from './deadline-isolation-guard.mjs';

// This is a synthetic-data smoke against a runtime owned by the caller, never a
// discovery mechanism for the user's default LM Studio server or provider env.
export function validateModelConfig(value) {
  const invalid = () => { throw Object.assign(new Error('Explicit isolated model ownership/configuration required'), { code: 'MODEL_CONFIGURATION_REQUIRED' }); };
  if (!value || value.opt_in !== true || value.ownership !== 'caller-owned-isolated'
    || Object.keys(value).some(key => !['opt_in', 'ownership', 'configuration'].includes(key))) invalid();
  const config = value.configuration;
  if (!config || Object.keys(config).some(key => !['base_url', 'model', 'context_tokens', 'output_tokens', 'timeout_ms', 'temperature'].includes(key))) invalid();
  let url;
  try { url = new URL(config.base_url); } catch { invalid(); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || Number(url.port) < 1024 || protectedPorts.has(Number(url.port))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) invalid();
  if (typeof config.model !== 'string' || !config.model.trim()
    || !Number.isInteger(config.context_tokens) || config.context_tokens < 8192
    || !Number.isInteger(config.output_tokens) || config.output_tokens < 512 || config.output_tokens >= config.context_tokens
    || !Number.isInteger(config.timeout_ms) || config.timeout_ms < 1000 || config.timeout_ms > 180000
    || config.temperature !== 0) invalid();
  return value;
}
