import { createForecastAdapter } from './shared.mjs';

// This adapter is intentionally test-only. Runtime execution has a separate smoke gate.
export function createAdapter() {
  return createForecastAdapter('weather-component-contract-double');
}
