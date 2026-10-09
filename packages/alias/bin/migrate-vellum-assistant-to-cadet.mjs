#!/usr/bin/env node
/**
 * npx shim: `npx migrate-vellum-assistant-to-cadet` resolves THIS package,
 * which hands off to the real CLI in @mycadet/vellum. The CLI is node-native
 * (the database migration steps run on node:sqlite, unflagged since node
 * 22.13), so a plain import is all it takes.
 */
import "@mycadet/vellum/cli";
