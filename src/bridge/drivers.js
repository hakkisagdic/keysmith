import { agyDriver } from './agy.js';
import { claudeDriver, codexDriver, opencodeDriver, qoderDriver } from './clis.js';

/**
 * The bridge drivers there are (BRIDGE_DRIVERS in cli-adapter.js names them for `bridge.driver`).
 * A CLI with none has no bridge: toolMode auto is EMULATE for it, toolMode mcp a 503.
 */
export const DRIVERS = [agyDriver, opencodeDriver, codexDriver, qoderDriver, claudeDriver];
