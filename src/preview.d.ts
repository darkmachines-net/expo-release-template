/** @file Types the public native development-server preparation boundary for consumer process supervisors. */

export interface DevelopmentServerOptions {
  port?: number | string;
  host?: string;
  clear?: boolean;
  web?: boolean;
  publicEnvironment?: Record<string, string | undefined>;
}

/** Prepare native Metro argv and a sanitized environment; declared development identity overrides caller values. */
export function developmentServer(root: string, options?: DevelopmentServerOptions): {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

/** Run the prepared native Metro process with inherited terminal IO until it exits. */
export function startDevelopment(root: string, options?: DevelopmentServerOptions): void;
