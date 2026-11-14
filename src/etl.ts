import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The part of the ETL's harmonization settings the server needs. */
export interface EtlParams {
  /** Fine grid of the ETL's fire cell-days, in degrees. */
  fineGridDeg: number;
  /** Where the value came from, reported by /status. */
  source: string;
}

/** Same value as HARMONIZATION.fineGridDeg in etl/src/harmonization.ts (v1), used when no ETL is found. */
const FALLBACK: EtlParams = { fineGridDeg: 0.02, source: 'built-in default (ETL not found)' };

interface Logger {
  warn(obj: unknown, msg?: string): void;
}

/**
 * Reads the harmonization parameters from the ETL package at runtime, so the server never
 * duplicates them. Loaded by file path, not by a static import, so the server also starts
 * when it is deployed without the ETL next to it.
 */
export async function loadEtlParams(etlDir: string | null, log: Logger): Promise<EtlParams> {
  if (!etlDir) {
    log.warn({ fallback: FALLBACK.fineGridDeg }, 'ETL not found (set ETL_DIR); using the default fine grid');
    return FALLBACK;
  }
  const file = path.join(etlDir, 'src', 'harmonization.ts');
  try {
    const { HARMONIZATION } = await import(pathToFileURL(file).href);
    return { fineGridDeg: Number(HARMONIZATION.fineGridDeg), source: file };
  } catch (error) {
    log.warn({ file, err: error }, 'could not load ETL harmonization parameters; using the default');
    return FALLBACK;
  }
}
