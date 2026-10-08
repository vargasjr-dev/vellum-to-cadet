#!/usr/bin/env node
/**
 * npx shim: `npx migrate-vellum-assistant-to-cadet` resolves THIS package,
 * which does nothing but hand off to the real CLI in @mycadet/vellum.
 */
import "@mycadet/vellum/cli";
