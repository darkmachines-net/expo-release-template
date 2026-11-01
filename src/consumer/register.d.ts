/** @file Type the lazy Expo application entrypoint that checks development-client runtime compatibility first. */
import type { ComponentType } from 'react';

/** Register a synchronously loaded root after checking native compatibility; do not statically import the app. */
export function registerRootComponent<P extends object>(loadApp: () => ComponentType<P>): void;
